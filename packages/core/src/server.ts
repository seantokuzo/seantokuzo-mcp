/**
 * MCP Server — routes all tool/resource calls through the plugin registry.
 * Entry point: node dist/core/server.js
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { PluginRegistry } from "./registry.js";
import { PluginLoader } from "./loader.js";
import { ConfigManager } from "./config.js";
import { KuzoLogger } from "./logger.js";
import { ConsentStore } from "./consent.js";
import { AuditLogger } from "./audit.js";

/** Convert a Zod schema to MCP-compatible JSON Schema */
function zodToMcpInputSchema(
  schema: Parameters<typeof zodToJsonSchema>[0],
): { type: "object"; properties?: Record<string, unknown>; required?: string[] } {
  const raw = zodToJsonSchema(schema) as Record<string, unknown>;
  return {
    type: "object",
    ...(raw["properties"]
      ? { properties: raw["properties"] as Record<string, unknown> }
      : {}),
    ...(Array.isArray(raw["required"])
      ? { required: raw["required"] as string[] }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Intrinsic hardening
// ---------------------------------------------------------------------------
//
// The exit guard installs early (before anything plugin-adjacent runs). The
// prototype freeze happens *after* the loader imports plugin manifests, because
// freezing Object.prototype breaks common JS patterns like TypeScript's
// transpiled namespace IIFE (e.g. `errorUtil.toString = ...` on a plain object
// inherits a now-read-only toString from the frozen prototype, and strict-mode
// ESM throws). Deferring the freeze until after manifest import:
//   - Keeps zero tool-call execution in the parent pre-freeze (2.5d moved all
//     plugin code to child processes; parent only reads manifests during
//     loader.loadAll).
//   - Seals the parent before the server starts serving any MCP requests.
//
// Children run without frozen prototypes today (plugin-host doesn't freeze);
// that's a separate hardening gap tracked for 2.5e+.

/** Stash the real process.exit for core shutdown paths */
const realExit: (code?: number) => never = process.exit.bind(process);

function installExitGuard(logger: KuzoLogger): void {
  process.exit = ((code?: number) => {
    logger.error(`Blocked process.exit(${code}) — a plugin tried to kill the server`);
  }) as typeof process.exit;
  logger.info("process.exit guard installed");
}

function freezePrototypes(logger: KuzoLogger): void {
  Object.freeze(Object.prototype);
  Object.freeze(Array.prototype);
  Object.freeze(Function.prototype);
  Object.freeze(RegExp.prototype);
  Object.freeze(String.prototype);
  Object.freeze(Number.prototype);
  Object.freeze(Boolean.prototype);
  logger.info("Intrinsic prototypes frozen");
}

async function main(): Promise<void> {
  const logger = new KuzoLogger("server");
  logger.info("Starting Kuzo MCP Server...");

  // Install the exit guard before touching any plugin-adjacent code
  installExitGuard(logger);

  // Initialize core systems
  const configManager = new ConfigManager();
  const registry = new PluginRegistry(new KuzoLogger("registry"));
  const consentStore = new ConsentStore();
  const auditLogger = new AuditLogger({ logger: new KuzoLogger("audit") });
  const loader = new PluginLoader(
    registry,
    configManager,
    new KuzoLogger("loader"),
    consentStore,
    auditLogger,
  );

  // Load plugins (imports plugin manifests — plugin dep init runs here)
  const loadResult = await loader.loadAll();

  // Freeze prototypes now that manifest imports are done but before serving
  // any MCP requests. See the hardening note above for the rationale.
  freezePrototypes(logger);

  if (loadResult.loaded.length === 0 && loadResult.failed.length > 0) {
    logger.error("No plugins loaded and some failed — check your configuration");
  }

  // Create MCP server
  const server = new Server(
    { name: "kuzo-mcp", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  // List tools — delegates to registry, converts Zod schemas to JSON Schema
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const registeredTools = registry.getAllTools();
    const tools = registeredTools.map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToMcpInputSchema(tool.inputSchema),
    }));
    return { tools };
  });

  // List resources — delegates to registry
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const registeredResources = registry.getAllResources();
    const resources = registeredResources.map(({ resource }) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    }));
    return { resources };
  });

  // Read resource — delegates to registry
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const entry = registry.findResource(uri);

    if (!entry) {
      throw new Error(`Unknown resource: ${uri}`);
    }

    const content = await entry.resource.handler(entry.context);
    return {
      contents: [{ uri, mimeType: entry.resource.mimeType, text: content }],
    };
  });

  // Call tool — validates with Zod, delegates to plugin handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const entry = registry.findTool(name);
      if (!entry) {
        throw new Error(`Unknown tool: ${name}`);
      }

      // Validate input through Zod schema, then call handler
      const validated = entry.tool.inputSchema.parse(args ?? {});
      const result = await entry.tool.handler(validated, entry.context);

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Tool "${name}" failed: ${message}`);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: false, error: message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  // Graceful shutdown with force-exit safety net
  const FORCE_EXIT_MS = 10_000;
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Safety net: if cleanup hangs, force-kill after timeout
    const forceTimer = setTimeout(() => {
      logger.error(`Shutdown timed out after ${FORCE_EXIT_MS}ms — forcing exit`);
      realExit(1);
    }, FORCE_EXIT_MS);
    forceTimer.unref();

    logger.info("Shutting down...");
    await loader.shutdownAll();
    await registry.shutdownAll();
    await server.close();
    realExit(0);
  };
  process.on("SIGINT", () => void shutdown().catch((err) => {
    logger.error("Shutdown failed", err);
    realExit(1);
  }));
  process.on("SIGTERM", () => void shutdown().catch((err) => {
    logger.error("Shutdown failed", err);
    realExit(1);
  }));

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("Kuzo MCP Server running on stdio");
}

main().catch((error) => {
  const logger = new KuzoLogger("server");
  logger.error("Failed to start MCP server", error);
  realExit(1);
});
