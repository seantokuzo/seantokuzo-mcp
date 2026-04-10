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

async function main(): Promise<void> {
  const logger = new KuzoLogger("server");
  logger.info("Starting Kuzo MCP Server...");

  // Initialize core systems
  const configManager = new ConfigManager();
  const registry = new PluginRegistry(new KuzoLogger("registry"));
  const loader = new PluginLoader(
    registry,
    configManager,
    new KuzoLogger("loader"),
  );

  // Load plugins
  const loadResult = await loader.loadAll();

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

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    await registry.shutdownAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("Kuzo MCP Server running on stdio");
}

main().catch((error) => {
  const logger = new KuzoLogger("server");
  logger.error("Failed to start MCP server", error);
  process.exit(1);
});
