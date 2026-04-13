/**
 * Plugin host — child process entry point for isolated plugin execution.
 *
 * Executed via child_process.fork(). Each instance loads exactly one plugin,
 * builds an IPC-backed PluginContext, and handles tool/resource calls.
 *
 * Entry: node dist/core/plugin-host.js
 */

import { pathToFileURL } from "url";
import { IpcChannel } from "./ipc.js";
import { DefaultCredentialBroker } from "./credentials.js";
import { AuditLogger } from "./audit.js";
import { KuzoLogger } from "./logger.js";
import {
  isV2Plugin,
  type CredentialCapability,
  type KuzoPlugin,
  type PluginContext,
  type PluginLogger,
  type ToolDefinition,
} from "../plugins/types.js";

// ---------------------------------------------------------------------------
// IPC-backed logger — relays log messages to parent process
// ---------------------------------------------------------------------------

function createIpcLogger(pluginName: string, channel: IpcChannel): PluginLogger {
  const send = (level: string, message: string, data?: unknown) => {
    channel.notify("log", { level, message, data, plugin: pluginName });
  };
  return {
    debug: (msg, data) => send("debug", msg, data),
    info: (msg, data) => send("info", msg, data),
    warn: (msg, data) => send("warn", msg, data),
    error: (msg, data) => send("error", msg, data),
  };
}

// ---------------------------------------------------------------------------
// Initialize params
// ---------------------------------------------------------------------------

interface InitParams {
  pluginName: string;
  pluginPath: string;
  env: Record<string, string>;
  capabilities: CredentialCapability[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!process.send) {
    process.stderr.write("plugin-host: must be launched via child_process.fork()\n");
    process.exit(1);
  }

  const channel = new IpcChannel(process);
  let plugin: KuzoPlugin | null = null;
  let pluginContext: PluginContext | null = null;
  let toolMap: Map<string, ToolDefinition> | null = null;

  // ── Handle incoming requests from parent ──
  channel.onRequest(async (method, params) => {
    switch (method) {
      case "initialize":
        return handleInitialize(params as InitParams, channel);

      case "callTool": {
        const { toolName, args } = params as { toolName: string; args: Record<string, unknown> };
        return handleCallTool(toolName, args);
      }

      case "readResource": {
        const { uri } = params as { uri: string };
        return handleReadResource(uri);
      }

      case "shutdown":
        return handleShutdown();

      case "ping":
        return "pong";

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  });

  // ── Initialize ──

  async function handleInitialize(initParams: InitParams, ch: IpcChannel): Promise<{ ok: true }> {
    const { pluginName, pluginPath, env, capabilities } = initParams;

    // Inject scoped env vars (replaces whatever fork() passed)
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = value;
    }

    // Build IPC-backed logger
    const logger = createIpcLogger(pluginName, ch);

    // Build config map from scoped env
    const config = new Map<string, string>();
    for (const [key, value] of Object.entries(env)) {
      config.set(key, value);
    }

    // Build credential broker (reconstructed in child — same as parent would)
    const auditLogger = new AuditLogger({ logger: new KuzoLogger(`audit:${pluginName}`) });
    const credentials = new DefaultCredentialBroker({
      pluginName,
      config,
      capabilities,
      logger,
      auditLogger,
    });

    // Build IPC-backed callTool (routes through parent's registry)
    const callTool = async (toolNameArg: string, argsArg: Record<string, unknown>): Promise<unknown> => {
      return ch.request("callTool", { toolName: toolNameArg, args: argsArg });
    };

    // Build PluginContext
    pluginContext = { credentials, logger, callTool };

    // Dynamic import the plugin module
    const pluginUrl = pathToFileURL(pluginPath).href;
    const module = (await import(pluginUrl)) as Record<string, unknown>;
    plugin = module["default"] as KuzoPlugin;

    if (!plugin?.name || !plugin.tools || !plugin.initialize) {
      throw new Error(`Invalid plugin at ${pluginPath}: must export default KuzoPlugin`);
    }

    // Index tools
    toolMap = new Map(plugin.tools.map((t) => [t.name, t]));

    // Initialize the plugin (this is where credentials are consumed, clients are created)
    await plugin.initialize(pluginContext);

    logger.info(
      `plugin-host: ${pluginName} initialized (${plugin.tools.length} tools, ` +
        `${plugin.resources?.length ?? 0} resources, ` +
        `permissionModel=${isV2Plugin(plugin) ? "v2" : "v1"})`,
    );

    return { ok: true };
  }

  // ── Tool calls ──

  async function handleCallTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!toolMap || !pluginContext) {
      throw new Error("Plugin not initialized");
    }

    const tool = toolMap.get(toolName);
    if (!tool) {
      throw new Error(`Tool "${toolName}" not found in this plugin`);
    }

    // Validate with Zod schema (defense-in-depth — parent already validated)
    const validated = tool.inputSchema.parse(args);
    return tool.handler(validated, pluginContext);
  }

  // ── Resource reads ──

  async function handleReadResource(uri: string): Promise<string> {
    if (!plugin || !pluginContext) {
      throw new Error("Plugin not initialized");
    }
    if (!plugin.resources) {
      throw new Error("This plugin has no resources");
    }
    const resource = plugin.resources.find((r) => r.uri === uri);
    if (!resource) {
      throw new Error(`Resource "${uri}" not found in this plugin`);
    }
    return resource.handler(pluginContext);
  }

  // ── Shutdown ──

  async function handleShutdown(): Promise<{ ok: true }> {
    if (plugin?.shutdown) {
      await plugin.shutdown();
    }
    // Give response time to flush, then exit
    setTimeout(() => process.exit(0), 100);
    return { ok: true };
  }
}

main().catch((err) => {
  process.stderr.write(`plugin-host: fatal error — ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
