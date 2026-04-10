/**
 * Plugin system type definitions.
 * Every integration implements KuzoPlugin.
 */

import type { z } from "zod";

/** Logger interface for plugins — subset of KuzoLogger */
export interface PluginLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/** Context provided to each plugin at initialization */
export interface PluginContext {
  /** Config values for this plugin (env var name -> value) */
  config: Map<string, string>;

  /** Plugin-scoped logger (prefixed with plugin name) */
  logger: PluginLogger;

  /**
   * Call a tool registered by any plugin.
   * This is the ONLY way plugins communicate — no direct imports.
   */
  callTool: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

/** MCP tool definition registered by a plugin */
export interface ToolDefinition {
  /** Tool name (e.g., "get_git_context", "create_pull_request") */
  name: string;

  /** Description shown to the LLM — be detailed, include usage tips */
  description: string;

  /** Zod schema for input validation. Converted to JSON Schema for MCP protocol. */
  inputSchema: z.ZodType;

  /** Handler called with validated args. Server catches errors and formats responses. */
  handler: (args: unknown, context: PluginContext) => Promise<unknown>;
}

/** MCP resource definition registered by a plugin */
export interface ResourceDefinition {
  /** Resource URI (e.g., "git://context") */
  uri: string;

  /** Human-readable name */
  name: string;

  /** Description */
  description: string;

  /** MIME type */
  mimeType: string;

  /** Handler that returns resource content */
  handler: (context: PluginContext) => Promise<string>;
}

/** Plugin interface — every integration implements this */
export interface KuzoPlugin {
  /** Unique plugin identifier (e.g., "github", "jira") */
  name: string;

  /** Human-readable description */
  description: string;

  /** Semver version string */
  version: string;

  /** Environment variables this plugin requires to function */
  requiredConfig?: string[];

  /** Environment variables this plugin can optionally use */
  optionalConfig?: string[];

  /** Called once when the plugin is loaded */
  initialize(context: PluginContext): Promise<void>;

  /** Called when the server is shutting down */
  shutdown?(): Promise<void>;

  /** MCP tools this plugin exposes */
  tools: ToolDefinition[];

  /** MCP resources this plugin exposes */
  resources?: ResourceDefinition[];
}

/** Per-plugin config entry */
export interface PluginConfig {
  enabled: boolean;
}

/** Root configuration for plugin enable/disable */
export interface KuzoConfig {
  plugins: Record<string, PluginConfig>;
}

/** Result of loading plugins */
export interface LoadResult {
  loaded: string[];
  skipped: Array<{ name: string; reason: string }>;
  failed: Array<{ name: string; error: string }>;
}
