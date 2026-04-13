/**
 * Plugin loader — discovers, validates, and initializes plugins.
 *
 * Consent flow (Phase 2.5c):
 *   - V1 plugins blocked unless KUZO_TRUST_LEGACY=true
 *   - V2 plugins require stored consent OR trust override
 *   - KUZO_TRUST_PLUGINS=name1,name2 — bypass consent for listed plugins
 *   - KUZO_TRUST_ALL=true — bypass consent for all (dev only)
 *   - KUZO_STRICT=true — only stored consent, no trust overrides
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
import { ConsentStore } from "./consent.js";
import { AuditLogger } from "./audit.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class PluginLoader {
  private readonly trustPlugins: Set<string>;
  private readonly trustAll: boolean;
  private readonly strict: boolean;
  private readonly trustLegacy: boolean;

  constructor(
    private registry: PluginRegistry,
    private configManager: ConfigManager,
    private logger: KuzoLogger,
    private consentStore: ConsentStore,
    private auditLogger: AuditLogger,
  ) {
    // Parse trust env vars once at construction
    this.trustPlugins = new Set(
      (process.env["KUZO_TRUST_PLUGINS"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    this.trustAll = process.env["KUZO_TRUST_ALL"] === "true";
    this.strict = process.env["KUZO_STRICT"] === "true";
    this.trustLegacy = process.env["KUZO_TRUST_LEGACY"] === "true";

    if (this.trustAll) {
      this.logger.warn("KUZO_TRUST_ALL=true — all plugins trusted without consent (dev mode)");
    }
    if (this.strict) {
      this.logger.info("KUZO_STRICT=true — only stored consent honored, trust overrides ignored");
    }
  }

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

  // -------------------------------------------------------------------------
  // Consent + trust
  // -------------------------------------------------------------------------

  /**
   * Check whether a plugin is trusted (via consent or override).
   * Returns undefined if trusted, or a reason string if not.
   */
  private checkConsent(plugin: KuzoPlugin): string | undefined {
    const name = plugin.name;

    // Strict mode: only stored consent
    if (this.strict) {
      if (!isV2Plugin(plugin)) {
        return "V1 plugin not allowed in strict mode";
      }
      if (!this.consentStore.hasConsent(name)) {
        return `no stored consent — run: kuzo consent`;
      }
      if (this.consentStore.isConsentStale(plugin)) {
        return `consent is stale (version or capabilities changed) — run: kuzo consent`;
      }
      return undefined;
    }

    // Trust overrides (non-strict)
    if (this.trustAll) return undefined;
    if (this.trustPlugins.has(name)) return undefined;

    // V2 check stored consent
    if (isV2Plugin(plugin)) {
      if (this.consentStore.hasConsent(name)) {
        if (this.consentStore.isConsentStale(plugin)) {
          return `consent is stale (version or capabilities changed) — run: kuzo consent`;
        }
        return undefined;
      }
      return `no consent — run: kuzo consent`;
    }

    // V1 legacy gate — if trustLegacy is set, V1 plugins are allowed through
    if (this.trustLegacy) return undefined;
    return "V1 plugin requires KUZO_TRUST_LEGACY=true or migrate to V2";
  }

  // -------------------------------------------------------------------------
  // Scoped callTool
  // -------------------------------------------------------------------------

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
          // TODO(2.5d): enforce per-tool granularity when process isolation lands.
          // For now, "plugin:tool" targets grant access to all tools in the plugin.
          const pluginName = c.target.split(":")[0];
          return pluginName ?? c.target;
        }),
    );
  }

  // -------------------------------------------------------------------------
  // Credential broker
  // -------------------------------------------------------------------------

  /** Extract credential capabilities from a V2 plugin's manifest */
  private extractCredentialCapabilities(plugin: KuzoPlugin): CredentialCapability[] {
    if (!isV2Plugin(plugin)) return [];
    const allCaps = [...plugin.capabilities, ...(plugin.optionalCapabilities ?? [])];
    return allCaps.filter((c): c is CredentialCapability => c.kind === "credentials");
  }

  /**
   * Build a credential broker for a plugin.
   * V2 plugins get a fully-functional broker scoped to their declared capabilities.
   * V1 plugins (behind KUZO_TRUST_LEGACY) receive an empty-capabilities broker.
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
      auditLogger: this.auditLogger,
    });
  }

  // -------------------------------------------------------------------------
  // Config extraction
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Plugin load
  // -------------------------------------------------------------------------

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
      const pm = plugin.permissionModel as unknown;
      if (pm !== undefined && pm !== 1) {
        result.failed.push({
          name,
          error: `unsupported permissionModel: ${String(pm)} (this server supports: 1)`,
        });
        return result;
      }

      // V1 legacy gate — must be checked before consent
      if (!isV2Plugin(plugin) && !this.trustLegacy) {
        this.auditLogger.log({
          plugin: name,
          action: "plugin.skipped",
          outcome: "denied",
          details: { reason: "V1 plugin blocked — set KUZO_TRUST_LEGACY=true to allow" },
        });
        result.skipped.push({
          name,
          reason: "V1 plugin blocked — set KUZO_TRUST_LEGACY=true or migrate to V2",
        });
        return result;
      }

      // Consent check
      const consentDenial = this.checkConsent(plugin);
      if (consentDenial) {
        this.auditLogger.log({
          plugin: name,
          action: "plugin.skipped",
          outcome: "denied",
          details: { reason: consentDenial },
        });
        result.skipped.push({ name, reason: consentDenial });
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

      // Extract config — V2 derives from capabilities, V1 gets nothing
      let config: Map<string, string>;
      let missing: string[];

      if (isV2Plugin(plugin)) {
        const v2Config = this.extractV2Config(plugin);
        ({ config, missing } = this.configManager.extractPluginConfig(
          v2Config.required,
          v2Config.optional,
        ));
      } else {
        // V1 plugins (behind KUZO_TRUST_LEGACY) get an empty config — no config declarations
        config = new Map();
        missing = [];
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

      // Build credential broker
      const pluginLogger = createPluginLogger(plugin.name);
      const credentials = this.buildCredentialBroker(plugin, config, pluginLogger);

      // Build PluginContext (no more config map — V2 uses broker, V1 is legacy)
      const context: PluginContext = {
        credentials,
        logger: pluginLogger,
        callTool,
      };

      // Initialize plugin
      await plugin.initialize(context);

      // Register in registry
      this.registry.register(plugin, context);

      // Audit: plugin loaded
      this.auditLogger.log({
        plugin: name,
        action: "plugin.loaded",
        outcome: "allowed",
        details: {
          version: plugin.version,
          permissionModel: isV2Plugin(plugin) ? "v2" : "v1",
          toolCount: plugin.tools.length,
        },
      });

      result.loaded.push(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.auditLogger.log({
        plugin: name,
        action: "plugin.failed",
        outcome: "error",
        details: { error: message },
      });
      result.failed.push({ name, error: message });
    }

    return result;
  }
}
