/**
 * Plugin loader — discovers, validates, and initializes plugins.
 */

import { pathToFileURL, fileURLToPath } from "url";
import { resolve, dirname } from "path";
import { existsSync } from "fs";
import type { KuzoPlugin, LoadResult, PluginContext } from "../plugins/types.js";
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

      // Validate required config
      const { config, missing } = this.configManager.extractPluginConfig(
        plugin.requiredConfig ?? [],
        plugin.optionalConfig ?? [],
      );

      if (missing.length > 0) {
        result.skipped.push({
          name,
          reason: `missing required config: ${missing.join(", ")}`,
        });
        return result;
      }

      // Build PluginContext
      const context: PluginContext = {
        config,
        logger: createPluginLogger(plugin.name),
        callTool: (toolName, args) => this.registry.callTool(toolName, args),
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
