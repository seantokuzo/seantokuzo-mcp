/**
 * Plugin loader — discovers, validates, and initializes plugins.
 */

import { pathToFileURL, fileURLToPath } from "url";
import { resolve, dirname } from "path";
import { existsSync } from "fs";
import {
  isV2Plugin,
  type Capability,
  type CredentialBroker,
  type CredentialCapability,
  type CrossPluginCapability,
  type KuzoPlugin,
  type LoadResult,
  type PluginContext,
} from "../plugins/types.js";
import type { PluginRegistry } from "./registry.js";
import type { ConfigManager } from "./config.js";
import { createPluginLogger, type KuzoLogger } from "./logger.js";
import { DefaultCredentialBroker } from "./credentials.js";

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

  /** Extract credential capabilities from a V2 plugin's manifest */
  private extractCredentialCapabilities(plugin: KuzoPlugin): CredentialCapability[] {
    if (!isV2Plugin(plugin)) return [];
    const allCaps = [...plugin.capabilities, ...(plugin.optionalCapabilities ?? [])];
    return allCaps.filter((c): c is CredentialCapability => c.kind === "credentials");
  }

  /**
   * Build a credential broker for a plugin.
   * V2 plugins get a fully-functional broker scoped to their declared capabilities.
   * V1 plugins still receive the default broker, but with no declared credential
   * capabilities; credential access remains denied, and they should use the
   * deprecated config map instead.
   */
  private buildCredentialBroker(
    plugin: KuzoPlugin,
    config: Map<string, string>,
    logger: ReturnType<typeof createPluginLogger>,
  ): CredentialBroker {
    const capabilities = this.extractCredentialCapabilities(plugin);
    return new DefaultCredentialBroker({
      pluginName: plugin.name,
      config,
      capabilities,
      logger,
    });
  }

  /**
   * Wrap a config Map in a Proxy that logs a deprecation warning on first access.
   * V1 plugins use config freely (no warning). V2 plugins get the warning.
   */
  private wrapConfigWithDeprecation(
    config: Map<string, string>,
    pluginName: string,
    logger: ReturnType<typeof createPluginLogger>,
    isV2: boolean,
  ): Map<string, string> {
    if (!isV2) return config;
    let warned = false;
    return new Proxy(config, {
      get(target, prop, receiver) {
        if (!warned && typeof prop === "string") {
          warned = true;
          logger.warn(
            `plugin "${pluginName}" is using deprecated context.config — migrate to context.credentials`,
          );
        }
        return Reflect.get(target, prop, receiver);
      },
    });
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

      // Build credential broker + deprecation-wrapped config
      const pluginLogger = createPluginLogger(plugin.name);
      const v2 = isV2Plugin(plugin);
      const credentials = this.buildCredentialBroker(plugin, config, pluginLogger);
      const wrappedConfig = this.wrapConfigWithDeprecation(config, name, pluginLogger, v2);

      // Build PluginContext
      const context: PluginContext = {
        config: wrappedConfig,
        credentials,
        logger: pluginLogger,
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
