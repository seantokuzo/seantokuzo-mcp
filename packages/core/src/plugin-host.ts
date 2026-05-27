/**
 * Plugin host — child process entry point for isolated plugin execution.
 *
 * Executed via child_process.fork(). Each instance loads exactly one plugin,
 * builds an IPC-backed PluginContext, and handles tool/resource calls.
 *
 * Entry: node dist/core/plugin-host.js
 */

import { IpcChannel } from "./ipc.js";
import { DefaultCredentialBroker } from "./credentials.js";
import type { AuditEvent, AuditLogger } from "./audit.js";
import {
  isV2Plugin,
  type CredentialCapability,
  type KuzoPlugin,
  type PluginContext,
  type PluginLogger,
  type ToolDefinition,
} from "@kuzo-mcp/types";

// ---------------------------------------------------------------------------
// IpcAuditLogger — child-side proxy that notifies the parent over IPC
// ---------------------------------------------------------------------------
//
// Phase 2.6 Theme 5 (spec §C.10). The plugin-host MUST NOT touch
// `audit.log` directly — the parent owns the file writer. Every audit
// event the in-child `DefaultCredentialBroker` produces is forwarded via
// `channel.notify("audit", { event })`; `plugin-process.handleAuditEvent`
// in the parent validates + stamps + writes.
//
// Imports of `FileBackedAuditLogger` (and `appendFile*` from `node:fs`)
// are ESLint-banned in this file — see `eslint.config.js`.

class IpcAuditLogger implements AuditLogger {
  constructor(private readonly channel: IpcChannel) {}

  log(event: Omit<AuditEvent, "timestamp">): void {
    // Match FileBackedAuditLogger's never-throw contract — audit emission
    // must never break the operation that triggered it. `IpcChannel.notify`
    // short-circuits on `closed` but `process.send` can still raise
    // synchronously in a teardown race (channel disconnected before
    // `closed` was set). Round-2 Correctness advisory.
    try {
      this.channel.notify("audit", { event });
    } catch (err) {
      process.stderr.write(
        `IpcAuditLogger: notify failed — ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  /**
   * Audit reads happen in the parent CLI only. Throw if a plugin tries to
   * call this — defense-in-depth; the type system already shields the
   * child from `FileBackedAuditLogger` via the file-writer-monopoly
   * ESLint rule.
   */
  query(): AuditEvent[] {
    throw new Error("audit.query() is parent-only; child plugins cannot read the audit log");
  }
}

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
  /** file:// URL of the plugin's module entry — resolved by the parent's plugin-resolver */
  pluginEntryUrl: string;
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
  let credentialBroker: DefaultCredentialBroker | null = null;
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

  // ── Notifications from parent ──
  //
  // Spec §C.11 — rotation cache invalidation. When a credential is rotated
  // on disk, the parent's directory-watch re-resolves this plugin's scoped
  // config and pushes the fresh Map here. Fire-and-forget: the broker swaps
  // its config + clears its client cache, so the next `getClient(...)` builds
  // a client with the rotated value. No restart required.
  channel.onNotification((method, params) => {
    if (method !== "credential.refresh") return;
    const config = (params as { config?: unknown } | null)?.config;
    if (config === null || typeof config !== "object" || !credentialBroker) return;
    credentialBroker.replaceConfigAtomically(
      new Map(Object.entries(config as Record<string, string>)),
    );
    pluginContext?.logger.info("credentials refreshed from parent");
  });

  // ── Initialize ──

  async function handleInitialize(initParams: InitParams, ch: IpcChannel): Promise<{ ok: true }> {
    const { pluginName, pluginEntryUrl, env, capabilities } = initParams;

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

    // Build credential broker (reconstructed in child — same as parent would).
    // The audit logger is IPC-backed: every emission notifies the parent via
    // `channel.notify("audit", { event })`. The parent's `handleAuditEvent`
    // in `plugin-process.ts` rate-limits, validates plugin identity + action
    // class, stamps `source: "child"` + child PID, and writes to `audit.log`.
    // Per spec §C.10, the child MUST NOT write to `audit.log` directly.
    const auditLogger = new IpcAuditLogger(ch);
    const credentials = new DefaultCredentialBroker({
      pluginName,
      config,
      capabilities,
      logger,
      auditLogger,
    });
    credentialBroker = credentials;

    // Build IPC-backed callTool (routes through parent's registry).
    // Use 120s timeout to match parent-side TOOL_CALL_TIMEOUT_MS — default 30s
    // would cause spurious timeouts on cross-plugin calls to slow tools.
    const CROSS_PLUGIN_TIMEOUT_MS = 120_000;
    const callTool = async (toolNameArg: string, argsArg: Record<string, unknown>): Promise<unknown> => {
      return ch.request("callTool", { toolName: toolNameArg, args: argsArg }, CROSS_PLUGIN_TIMEOUT_MS);
    };

    // Build PluginContext
    pluginContext = { credentials, logger, callTool };

    // Dynamic import the plugin module — URL already resolved by parent
    const module = (await import(pluginEntryUrl)) as Record<string, unknown>;
    plugin = module["default"] as KuzoPlugin;

    if (!plugin?.name || !plugin.tools || !plugin.initialize) {
      throw new Error(`Invalid plugin at ${pluginEntryUrl}: must export default KuzoPlugin`);
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
    // Per spec §C.5 child-side scrub — wired AFTER plugin.shutdown() so the
    // plugin can finish whatever it was doing with its credentials map, then
    // BEFORE process.exit so the in-memory references are dropped before the
    // process tears down. The parent never holds the child's broker, so there
    // is no parallel shutdown path in `server.ts`.
    //
    // try/finally so the broker scrub runs even if `plugin.shutdown()`
    // rejects (round-2 Security/Correctness advisory). The throw still
    // propagates after the finally — the parent's `plugin-process`
    // observes the rejected request, which is the correct surfacing of a
    // plugin's failed shutdown.
    try {
      if (plugin?.shutdown) {
        await plugin.shutdown();
      }
    } finally {
      credentialBroker?.shutdown();
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
