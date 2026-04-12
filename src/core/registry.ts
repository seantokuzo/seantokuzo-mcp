/**
 * Plugin registry — stores loaded plugins and routes tool/resource calls.
 */

import type {
  KuzoPlugin,
  ToolDefinition,
  ResourceDefinition,
  PluginContext,
} from "../plugins/types.js";
import type { KuzoLogger } from "./logger.js";

export interface RegisteredTool {
  plugin: KuzoPlugin;
  tool: ToolDefinition;
  context: PluginContext;
}

export interface RegisteredResource {
  plugin: KuzoPlugin;
  resource: ResourceDefinition;
  context: PluginContext;
}

export class PluginRegistry {
  private plugins = new Map<string, KuzoPlugin>();
  private toolMap = new Map<string, RegisteredTool>();
  private resourceMap = new Map<string, RegisteredResource>();

  constructor(private logger: KuzoLogger) {}

  /** Register a plugin and index its tools and resources */
  register(plugin: KuzoPlugin, context: PluginContext): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }

    this.plugins.set(plugin.name, plugin);

    for (const tool of plugin.tools) {
      if (this.toolMap.has(tool.name)) {
        // Don't name the existing plugin — prevents probing which plugins are loaded
        throw new Error(
          `Tool name collision: "${tool.name}" is already registered`,
        );
      }
      this.toolMap.set(tool.name, { plugin, tool, context });
    }

    if (plugin.resources) {
      for (const resource of plugin.resources) {
        if (this.resourceMap.has(resource.uri)) {
          throw new Error(
            `Resource URI collision: "${resource.uri}" is already registered`,
          );
        }
        this.resourceMap.set(resource.uri, { plugin, resource, context });
      }
    }

    this.logger.info(
      `Registered "${plugin.name}" v${plugin.version} — ${plugin.tools.length} tools, ${plugin.resources?.length ?? 0} resources`,
    );
  }

  /** Get a plugin by name */
  getPlugin(name: string): KuzoPlugin | undefined {
    return this.plugins.get(name);
  }

  /** Get all registered plugins */
  getAllPlugins(): KuzoPlugin[] {
    return Array.from(this.plugins.values());
  }

  /** Get all registered tools with their plugin and context */
  getAllTools(): RegisteredTool[] {
    return Array.from(this.toolMap.values());
  }

  /** Find a tool by name */
  findTool(name: string): RegisteredTool | undefined {
    return this.toolMap.get(name);
  }

  /** Get all registered resources */
  getAllResources(): RegisteredResource[] {
    return Array.from(this.resourceMap.values());
  }

  /** Find a resource by URI */
  findResource(uri: string): RegisteredResource | undefined {
    return this.resourceMap.get(uri);
  }

  /**
   * Call a tool by name. Used for cross-plugin communication via PluginContext.callTool().
   * Validates input through the tool's Zod schema before calling the handler.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const entry = this.toolMap.get(toolName);
    if (!entry) {
      throw new Error(`Tool "${toolName}" not found in registry`);
    }

    const validated = entry.tool.inputSchema.parse(args);
    return entry.tool.handler(validated, entry.context);
  }

  /** Shut down all plugins gracefully, with per-plugin timeout */
  async shutdownAll(): Promise<void> {
    const SHUTDOWN_TIMEOUT = 5_000;

    for (const plugin of this.plugins.values()) {
      if (plugin.shutdown) {
        try {
          await Promise.race([
            plugin.shutdown(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("shutdown timeout")),
                SHUTDOWN_TIMEOUT,
              ),
            ),
          ]);
          this.logger.info(`Plugin "${plugin.name}" shut down`);
        } catch (err) {
          this.logger.error(
            `Plugin "${plugin.name}" shutdown failed/timed out`,
            err,
          );
        }
      }
    }
  }
}
