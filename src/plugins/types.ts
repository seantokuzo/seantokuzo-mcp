/**
 * Plugin system type definitions.
 * Every integration implements KuzoPlugin (V1 or V2).
 */

import type { z } from "zod";

// ---------------------------------------------------------------------------
// Capability types — declared in plugin manifests, enforced incrementally by the loader
// ---------------------------------------------------------------------------

/** How a plugin consumes a credential */
export type CredentialAccessMode = "client" | "authenticated-fetch" | "raw";

/** Access to an environment variable / secret */
export interface CredentialCapability {
  kind: "credentials";
  /** Env var name (e.g., "GITHUB_TOKEN"). Prefix patterns like "JIRA:*" are reserved for future use. */
  env: string;
  /** How the plugin consumes this credential */
  access: CredentialAccessMode;
  /** For authenticated-fetch: URL pattern (e.g., "https://api.github.com/*") */
  urlPattern?: string;
  /** For authenticated-fetch: how auth is injected */
  authScheme?: "bearer" | "basic" | "header";
  /** For basic auth: which credential key holds the username */
  basicUsername?: string;
  /** For header auth: custom header name */
  headerName?: string;
  /** Human-readable reason — shown during consent */
  reason: string;
}

/** Outbound HTTP/HTTPS request permission */
export interface NetworkCapability {
  kind: "network";
  /** Domain or pattern (e.g., "api.github.com" or "*.atlassian.net") */
  domain: string;
  reason: string;
}

/** File system read/write access */
export interface FilesystemCapability {
  kind: "filesystem";
  access: "read" | "write" | "read-write";
  /** Path pattern with $CWD substitution */
  path: string;
  reason: string;
}

/** Permission to call another plugin's tools */
export interface CrossPluginCapability {
  kind: "cross-plugin";
  /** Plugin name or "plugin:tool" for per-tool granularity */
  target: string;
  reason: string;
}

/** OS-level operation permission */
export interface SystemCapability {
  kind: "system";
  operation: "exec";
  /** Specific command, or omit for general exec */
  command?: string;
  reason: string;
}

/** Union of all capability types — discriminated on `kind` */
export type Capability =
  | CredentialCapability
  | NetworkCapability
  | FilesystemCapability
  | CrossPluginCapability
  | SystemCapability;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/** Logger interface for plugins — subset of KuzoLogger */
export interface PluginLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

// ---------------------------------------------------------------------------
// Plugin context
// ---------------------------------------------------------------------------

/** Context provided to each plugin at initialization */
export interface PluginContext {
  /** Config values for this plugin (env var name -> value) */
  config: Map<string, string>;

  /** Plugin-scoped logger (prefixed with plugin name) */
  logger: PluginLogger;

  /**
   * Call a tool registered by another plugin.
   * V2 plugins: scoped to declared cross-plugin dependencies.
   * V1 plugins: unrestricted (legacy behavior).
   */
  callTool: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Tool & resource definitions
// ---------------------------------------------------------------------------

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

/**
 * Helper to define a tool with full type inference.
 * The Zod schema type flows through to the handler's `args` parameter,
 * so handlers receive typed args without manual `.parse()`.
 */
export function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  inputSchema: S;
  handler: (args: z.infer<S>, context: PluginContext) => Promise<unknown>;
}): ToolDefinition {
  return def as ToolDefinition;
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

// ---------------------------------------------------------------------------
// Plugin interfaces — discriminated union on `permissionModel`
// ---------------------------------------------------------------------------

/** Shared fields across all plugin manifest versions */
interface KuzoPluginBase {
  /** Unique plugin identifier (e.g., "github", "jira") */
  name: string;

  /** Human-readable description */
  description: string;

  /** Semver version string */
  version: string;

  /** Called once when the plugin is loaded */
  initialize(context: PluginContext): Promise<void>;

  /** Called when the server is shutting down */
  shutdown?(): Promise<void>;

  /** MCP tools this plugin exposes */
  tools: ToolDefinition[];

  /** MCP resources this plugin exposes */
  resources?: ResourceDefinition[];
}

/**
 * V1 plugin manifest — legacy, pre-capability model.
 * Uses flat requiredConfig/optionalConfig for env var access.
 * Unrestricted callTool, network, filesystem.
 * @deprecated Migrate to V2 with capability declarations.
 */
export interface KuzoPluginV1 extends KuzoPluginBase {
  /** Absent or undefined — identifies this as a V1 manifest */
  permissionModel?: undefined;

  /** Environment variables this plugin requires to function */
  requiredConfig?: string[];

  /** Environment variables this plugin can optionally use */
  optionalConfig?: string[];
}

/**
 * V2 plugin manifest — capability-based permission model.
 * Plugins declare exactly what they need; the loader enforces it.
 */
export interface KuzoPluginV2 extends KuzoPluginBase {
  /** Permission model version — discriminant for the union */
  permissionModel: 1;

  /** Required capabilities — all must be granted for plugin to load */
  capabilities: Capability[];

  /** Optional capabilities — plugin works without them */
  optionalCapabilities?: Capability[];
}

/** Union of all plugin manifest versions */
export type KuzoPlugin = KuzoPluginV1 | KuzoPluginV2;

/** Type guard: is this a V2 plugin with capability declarations? */
export function isV2Plugin(plugin: KuzoPlugin): plugin is KuzoPluginV2 {
  return plugin.permissionModel === 1;
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

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
