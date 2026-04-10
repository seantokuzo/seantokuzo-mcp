/**
 * Configuration management.
 * Handles env var loading (dotenv) and per-plugin config extraction.
 */

import { config as dotenvConfig } from "dotenv";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { KuzoConfig } from "../plugins/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Default plugin configuration — edit this to enable/disable plugins */
const DEFAULT_PLUGIN_CONFIG: KuzoConfig = {
  plugins: {
    "git-context": { enabled: true },
    github: { enabled: true },
    jira: { enabled: true },
  },
};

export class ConfigManager {
  private kuzoConfig: KuzoConfig;

  constructor() {
    this.loadDotenv();
    this.kuzoConfig = DEFAULT_PLUGIN_CONFIG;
  }

  /** Load .env file from multiple possible locations */
  private loadDotenv(): void {
    const possiblePaths = [
      resolve(__dirname, "../../.env"), // dist/core -> project root
      resolve(__dirname, "../../../.env"), // one more level
      resolve(process.cwd(), ".env"), // cwd
    ];

    const envPath = possiblePaths.find((p) => existsSync(p));
    if (envPath) {
      dotenvConfig({ path: envPath });
    } else {
      dotenvConfig();
    }
  }

  /** Get a single env var value */
  get(key: string): string | undefined {
    return process.env[key];
  }

  /** Get the full plugin configuration */
  getPluginConfig(): KuzoConfig {
    return this.kuzoConfig;
  }

  /** Check if a plugin is enabled in config */
  isPluginEnabled(name: string): boolean {
    return this.kuzoConfig.plugins[name]?.enabled ?? false;
  }

  /**
   * Extract and validate config for a specific plugin.
   * Returns the config map and any missing required keys.
   */
  extractPluginConfig(
    requiredKeys: string[],
    optionalKeys: string[],
  ): { config: Map<string, string>; missing: string[] } {
    const config = new Map<string, string>();
    const missing: string[] = [];

    for (const key of requiredKeys) {
      const value = process.env[key];
      if (value) {
        config.set(key, value);
      } else {
        missing.push(key);
      }
    }

    for (const key of optionalKeys) {
      const value = process.env[key];
      if (value) {
        config.set(key, value);
      }
    }

    return { config, missing };
  }
}
