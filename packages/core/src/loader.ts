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

import {
  isV2Plugin,
  type Capability,
  type CredentialCapability,
  type CrossPluginCapability,
  type KuzoPlugin,
  type LoadResult,
  type PluginContext,
  type ResourceDefinition,
  type ToolDefinition,
} from "@kuzo-mcp/types";
import type { PluginRegistry } from "./registry.js";
import type { ConfigManager } from "./config.js";
import { createPluginLogger, KuzoLogger } from "./logger.js";
import { ConsentStore } from "./consent.js";
import { AuditLogger } from "./audit.js";
import { PluginProcess } from "./plugin-process.js";
import { resolvePluginEntry } from "./plugin-resolver.js";

export class PluginLoader {
  private readonly trustPlugins: Set<string>;
  private readonly trustAll: boolean;
  private readonly strict: boolean;
  private readonly trustLegacy: boolean;
  private readonly pluginProcesses = new Map<string, PluginProcess>();

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

  /** Shut down all plugin child processes */
  async shutdownAll(): Promise<void> {
    const shutdowns = Array.from(this.pluginProcesses.values()).map((pp) =>
      pp.shutdown().catch((err) => {
        this.logger.error(`Shutdown failed for plugin process`, err instanceof Error ? err.message : err);
      }),
    );
    await Promise.all(shutdowns);
    this.pluginProcesses.clear();
  }

  // -------------------------------------------------------------------------
  // Consent + trust
  // -------------------------------------------------------------------------

  /**
   * Check whether a plugin is trusted (via consent or override).
   * Returns undefined if trusted, or a reason string if not.
   * Emits consent.checked audit events for every decision.
   */
  private checkConsent(plugin: KuzoPlugin): string | undefined {
    const name = plugin.name;

    const allow = (reason: string): undefined => {
      this.auditLogger.log({
        plugin: name,
        action: "consent.checked",
        outcome: "allowed",
        details: { reason },
      });
      return undefined;
    };
    const deny = (reason: string): string => {
      this.auditLogger.log({
        plugin: name,
        action: "consent.checked",
        outcome: "denied",
        details: { reason },
      });
      return reason;
    };

    // Strict mode: only stored consent
    if (this.strict) {
      if (!isV2Plugin(plugin)) {
        return deny("V1 plugin not allowed in strict mode");
      }
      if (!this.consentStore.hasConsent(name)) {
        return deny("no stored consent — run: kuzo consent");
      }
      if (this.consentStore.isConsentStale(plugin)) {
        return deny("consent is stale (version or capabilities changed) — run: kuzo consent");
      }
      return allow("stored consent valid (strict mode)");
    }

    // Trust overrides (non-strict)
    if (this.trustAll) return allow("KUZO_TRUST_ALL");
    if (this.trustPlugins.has(name)) return allow("KUZO_TRUST_PLUGINS");

    // V2 check stored consent
    if (isV2Plugin(plugin)) {
      if (this.consentStore.hasConsent(name)) {
        if (this.consentStore.isConsentStale(plugin)) {
          return deny("consent is stale (version or capabilities changed) — run: kuzo consent");
        }
        return allow("stored consent valid");
      }
      return deny("no consent — run: kuzo consent");
    }

    // V1 legacy gate — if trustLegacy is set, V1 plugins are allowed through
    if (this.trustLegacy) return allow("KUZO_TRUST_LEGACY");
    return deny("V1 plugin requires KUZO_TRUST_LEGACY=true or migrate to V2");
  }

  // -------------------------------------------------------------------------
  // Cross-plugin deps
  // -------------------------------------------------------------------------

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
  // Capability extraction
  // -------------------------------------------------------------------------

  /** Extract credential capabilities from a V2 plugin's manifest */
  private extractCredentialCapabilities(plugin: KuzoPlugin): CredentialCapability[] {
    if (!isV2Plugin(plugin)) return [];
    const allCaps = [...plugin.capabilities, ...(plugin.optionalCapabilities ?? [])];
    return allCaps.filter((c): c is CredentialCapability => c.kind === "credentials");
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
      // Resolve plugin entry via package name — works in both installed-mode
      // (~/.kuzo/plugins/<name>/node_modules/<pkg>/) and dev-mode (workspace
      // symlink via import.meta.resolve). See plugin-resolver.ts.
      let pluginEntryUrl: string;
      try {
        pluginEntryUrl = resolvePluginEntry(name, this.configManager.getPluginConfig());
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.auditLogger.log({ plugin: name, action: "plugin.skipped", outcome: "denied", details: { reason } });
        result.skipped.push({ name, reason });
        return result;
      }

      // Dynamic import — read the plugin manifest in the parent to run consent
      // checks + build the registry proxy. The child process independently
      // imports the same URL and executes initialize().
      const module = (await import(pluginEntryUrl)) as Record<string, unknown>;
      const plugin = module["default"] as KuzoPlugin | undefined;

      if (!plugin?.name || !plugin.tools || !plugin.initialize) {
        const error = "invalid plugin: must export default KuzoPlugin with name, tools, and initialize";
        this.auditLogger.log({ plugin: name, action: "plugin.failed", outcome: "error", details: { error } });
        result.failed.push({ name, error });
        return result;
      }

      // Reject unknown permission model versions.
      const pm = plugin.permissionModel as unknown;
      if (pm !== undefined && pm !== 1) {
        const error = `unsupported permissionModel: ${String(pm)} (this server supports: 1)`;
        this.auditLogger.log({ plugin: name, action: "plugin.failed", outcome: "error", details: { error } });
        result.failed.push({ name, error });
        return result;
      }

      // V1 legacy gate — must be checked before consent.
      // In strict mode, trust overrides are ignored so suggesting KUZO_TRUST_LEGACY is misleading.
      if (!isV2Plugin(plugin)) {
        const blocked = this.strict || !this.trustLegacy;
        if (blocked) {
          const reason = this.strict
            ? "V1 plugin blocked in strict mode — trust overrides are ignored; migrate to V2"
            : "V1 plugin blocked — set KUZO_TRUST_LEGACY=true or migrate to V2";
          this.auditLogger.log({
            plugin: name,
            action: "plugin.skipped",
            outcome: "denied",
            details: { reason },
          });
          result.skipped.push({ name, reason });
          return result;
        }
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
        const error = "V2 plugin must provide capabilities array";
        this.auditLogger.log({ plugin: name, action: "plugin.failed", outcome: "error", details: { error } });
        result.failed.push({ name, error });
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
        const reason = `missing required config: ${missing.join(", ")}`;
        this.auditLogger.log({ plugin: name, action: "plugin.skipped", outcome: "denied", details: { reason } });
        result.skipped.push({ name, reason });
        return result;
      }

      // Extract deps and capabilities for the child process.
      // V1 plugins get null deps (unrestricted callTool). V2 gets scoped set.
      const deps = isV2Plugin(plugin) ? this.extractCrossPluginDeps(plugin) : null;
      const capabilities = this.extractCredentialCapabilities(plugin);
      const pluginLogger = createPluginLogger(plugin.name);

      // Create PluginProcess — lazy, doesn't spawn until first tool call
      const pluginProcess = new PluginProcess(
        plugin.name,
        pluginEntryUrl,
        Object.fromEntries(config),
        capabilities,
        deps,
        new KuzoLogger(plugin.name),
        this.registry,
        this.auditLogger,
      );
      this.pluginProcesses.set(plugin.name, pluginProcess);

      // Build proxy tools — real Zod schemas for listing, handlers proxy to child
      const proxyTools: ToolDefinition[] = plugin.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        handler: async (args: unknown) =>
          pluginProcess.callTool(tool.name, args as Record<string, unknown>),
      }));

      // Build proxy resources
      const proxyResources: ResourceDefinition[] | undefined = plugin.resources?.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
        handler: async () => pluginProcess.readResource(resource.uri),
      }));

      // Create proxy plugin for registry (same manifest, proxy handlers)
      const proxyBase = {
        name: plugin.name,
        description: plugin.description,
        version: plugin.version,
        tools: proxyTools,
        resources: proxyResources,
        initialize: async () => { /* Handled by child process */ },
        shutdown: async () => { /* Handled by loader.shutdownAll() */ },
      };

      const proxyPlugin: KuzoPlugin = isV2Plugin(plugin)
        ? {
            ...proxyBase,
            permissionModel: plugin.permissionModel,
            capabilities: plugin.capabilities,
            optionalCapabilities: plugin.optionalCapabilities,
          }
        : proxyBase;

      // Minimal context for registry — proxy tools don't use it
      const proxyContext: PluginContext = {
        credentials: {
          getClient: () => undefined,
          createAuthenticatedFetch: () => { throw new Error("Proxy context"); },
          getRawCredential: () => undefined,
          hasCredential: () => false,
        },
        logger: pluginLogger,
        callTool: async () => { throw new Error("Proxy context — use PluginProcess"); },
      };

      this.registry.register(proxyPlugin, proxyContext);

      // Audit: plugin registered (will be initialized lazily on first tool call)
      this.auditLogger.log({
        plugin: name,
        action: "plugin.loaded",
        outcome: "allowed",
        details: {
          version: plugin.version,
          permissionModel: isV2Plugin(plugin) ? "v2" : "v1",
          toolCount: plugin.tools.length,
          isolated: true,
          lazySpawn: true,
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
