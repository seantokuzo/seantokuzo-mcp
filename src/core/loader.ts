/**
 * Plugin loader — discovers, validates, and initializes plugins.
 */

import { pathToFileURL, fileURLToPath } from "url";
import { resolve, dirname } from "path";
import { existsSync } from "fs";
import {
  isV2Plugin,
  type Capability,
  type CredentialCapability,
  type CrossPluginCapability,
  type KuzoPlugin,
  type LoadResult,
  type PluginContext,
} from "../plugins/types.js";
import type { PluginRegistry } from "./registry.js";
import type { ConfigManager } from "./config.js";
import { createPluginLogger, type KuzoLogger } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class PluginLoader {
  constructor(
    private registry: PluginRegistry,
    private configManager: ConfigManager,
    private logger: KuzoLogger,
  ) {}

  /** Load all enabled plugins from config */
  async loadAll(): Promise<LoadResult> {
    const result: LoadResult = { loaded: [], skipped: [], failed: [] };
    const kuzoConfig = this.configManager.getPluginConfig();

    for (const [name, pluginConf] of Object.entries(kuzoConfig.plugins)) {
      if (!pluginConf.enabled) {
        result.skipped.push({ name, reason: "disabled in config" });
        continue;
      }

      const pluginResult = await this.loadPlugin(name);
      result.loaded.push(...pluginResult.loaded);
      result.skipped.push(...pluginResult.skipped);
      result.failed.push(...pluginResult.failed);
    }

    // Log summary
    this.logger.info(
      `Load complete: ${result.loaded.length} loaded, ${result.skipped.length} skipped, ${result.failed.length} failed`,
    );
    if (result.loaded.length > 0) {
      this.logger.info(`Loaded: ${result.loaded.join(", ")}`);
    }
    for (const skip of result.skipped) {
      this.logger.warn(`Skipped: ${skip.name} (${skip.reason})`);
    }
    for (const fail of result.failed) {
      this.logger.error(`Failed: ${fail.name} — ${fail.error}`);
    }

    return result;
  }

  /**
   * Build a scoped callTool for V2 plugins.
   * Only allows calls to tools owned by plugins declared in cross-plugin capabilities.
   * Undeclared targets get "not found" — don't leak existence with "permission denied".
   */
  private buildScopedCallTool(
    declaredDeps: Set<string>,
  ): PluginContext["callTool"] {
    return async (toolName, args) => {
      const entry = this.registry.findTool(toolName);
      if (!entry || !declaredDeps.has(entry.plugin.name)) {
        throw new Error(`Tool "${toolName}" not found`);
      }
      return this.registry.callTool(toolName, args);
    };
  }

  /** Extract declared cross-plugin dependency names from V2 capabilities */
  private extractCrossPluginDeps(plugin: KuzoPlugin): Set<string> {
    if (!isV2Plugin(plugin)) return new Set();
    const allCaps = [...plugin.capabilities, ...(plugin.optionalCapabilities ?? [])];
    return new Set(
      allCaps
        .filter((c): c is CrossPluginCapability => c.kind === "cross-plugin")
        .map((c) => {
          // TODO(2.5c): enforce per-tool granularity when consent flow lands.
          // For now, "plugin:tool" targets grant access to all tools in the plugin.
          const pluginName = c.target.split(":")[0];
          return pluginName ?? c.target;
        }),
    );
  }

  /** Extract required env var names from V2 credential capabilities */
  private extractV2Config(plugin: KuzoPlugin): { required: string[]; optional: string[] } {
    if (!isV2Plugin(plugin)) return { required: [], optional: [] };
    const toEnvVars = (caps: Capability[]) =>
      caps
        .filter((c): c is CredentialCapability => c.kind === "credentials")
        .map((c) => c.env);
    return {
      required: toEnvVars(plugin.capabilities),
      optional: toEnvVars(plugin.optionalCapabilities ?? []),
    };
  }

  /** Load a single plugin by name */
  async loadPlugin(name: string): Promise<LoadResult> {
    const result: LoadResult = { loaded: [], skipped: [], failed: [] };

    try {
      // Resolve plugin module path relative to compiled output
      const pluginPath = resolve(__dirname, "..", "plugins", name, "index.js");

      if (!existsSync(pluginPath)) {
        result.skipped.push({
          name,
          reason: `module not found at plugins/${name}/index.js`,
        });
        return result;
      }

      // Dynamic import
      const pluginUrl = pathToFileURL(pluginPath).href;
      const module = (await import(pluginUrl)) as Record<string, unknown>;
      const plugin = module["default"] as KuzoPlugin | undefined;

      if (!plugin?.name || !plugin.tools || !plugin.initialize) {
        result.failed.push({
          name,
          error: "invalid plugin: must export default KuzoPlugin with name, tools, and initialize",
        });
        return result;
      }

      // Reject unknown permission model versions.
      // Cast to unknown: TS narrows the union to only undefined|1, but a
      // dynamically loaded JS plugin could export any value at runtime.
      const pm = plugin.permissionModel as unknown;
      if (pm !== undefined && pm !== 1) {
        result.failed.push({
          name,
          error: `unsupported permissionModel: ${String(pm)} (this server supports: 1)`,
        });
        return result;
      }

      // Runtime validation for V2 manifests
      if (isV2Plugin(plugin) && !Array.isArray(plugin.capabilities)) {
        result.failed.push({
          name,
          error: "V2 plugin must provide capabilities array",
        });
        return result;
      }

      // Extract config — V2 derives from capabilities, V1 uses requiredConfig/optionalConfig
      let config: Map<string, string>;
      let missing: string[];

      if (isV2Plugin(plugin)) {
        const v2Config = this.extractV2Config(plugin);
        ({ config, missing } = this.configManager.extractPluginConfig(
          v2Config.required,
          v2Config.optional,
        ));
      } else {
        ({ config, missing } = this.configManager.extractPluginConfig(
          plugin.requiredConfig ?? [],
          plugin.optionalConfig ?? [],
        ));
      }

      if (missing.length > 0) {
        result.skipped.push({
          name,
          reason: `missing required config: ${missing.join(", ")}`,
        });
        return result;
      }

      // Build callTool — V2 gets scoped, V1 gets unrestricted
      const deps = this.extractCrossPluginDeps(plugin);
      const callTool = isV2Plugin(plugin)
        ? this.buildScopedCallTool(deps)
        : (toolName: string, args: Record<string, unknown>) =>
            this.registry.callTool(toolName, args);

      // Build PluginContext
      const context: PluginContext = {
        config,
        logger: createPluginLogger(plugin.name),
        callTool,
      };

      // Initialize plugin
      await plugin.initialize(context);

      // Register in registry
      this.registry.register(plugin, context);

      result.loaded.push(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed.push({ name, error: message });
    }

    return result;
  }
}
