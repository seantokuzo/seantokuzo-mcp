/**
 * Credential broker — secure credential access for plugins.
 *
 * Plugins receive pre-authenticated clients or scoped fetch wrappers
 * instead of raw tokens. Raw access is an audited escape hatch.
 *
 * First-party client factories (GitHub, Jira) are hardcoded here.
 * Third-party plugins can register their own factories in Phase 2.5d+.
 */

import type {
  AuthenticatedFetch,
  CredentialBroker,
  CredentialCapability,
  PluginLogger,
} from "@kuzo-mcp/types";
import type { AuditLogger } from "./audit.js";
import { GitHubClient } from "../plugins/github/client.js";
import { JiraClient } from "../plugins/jira/client.js";

// ---------------------------------------------------------------------------
// Client factory registry — hardcoded for first-party services (Option A)
// ---------------------------------------------------------------------------

type ClientFactory = (
  config: Map<string, string>,
  logger: PluginLogger,
) => unknown | undefined;

/**
 * Maps service name → the primary env vars the factory consumes.
 * Used to verify that the plugin declared `access: "client"` for at least
 * one of the service's credentials.
 */
const serviceEnvMapping: Record<string, string[]> = {
  github: ["GITHUB_TOKEN"],
  jira: ["JIRA_HOST", "JIRA_EMAIL", "JIRA_API_TOKEN"],
};

/**
 * Factory functions for first-party services.
 * Each reads from the config map (already scoped to the plugin by the loader)
 * and returns a fully-configured client. Returns undefined if required
 * credentials are missing.
 */
const clientFactories = new Map<string, ClientFactory>([
  [
    "github",
    (config, logger) => {
      const token = config.get("GITHUB_TOKEN");
      if (!token) return undefined;
      return new GitHubClient({
        token,
        username: config.get("GITHUB_USERNAME"),
        logger,
      });
    },
  ],
  [
    "jira",
    (config, logger) => {
      const host = config.get("JIRA_HOST");
      const email = config.get("JIRA_EMAIL");
      const token = config.get("JIRA_API_TOKEN");
      if (!host || !email || !token) return undefined;
      return new JiraClient({ host, email, token, logger });
    },
  ],
]);

// ---------------------------------------------------------------------------
// DefaultCredentialBroker
// ---------------------------------------------------------------------------

export interface CredentialBrokerOptions {
  /** Plugin name — used in audit logs and error messages */
  pluginName: string;
  /** Scoped config map (env var name → value) from the loader */
  config: Map<string, string>;
  /** Credential capabilities declared by this plugin */
  capabilities: CredentialCapability[];
  /** Plugin-scoped logger */
  logger: PluginLogger;
  /** Structured audit logger (file + stderr) */
  auditLogger?: AuditLogger;
}

export class DefaultCredentialBroker implements CredentialBroker {
  private readonly pluginName: string;
  private readonly config: Map<string, string>;
  private readonly capabilities: CredentialCapability[];
  private readonly logger: PluginLogger;
  private readonly auditLogger: AuditLogger | undefined;
  private readonly clientCache = new Map<string, unknown>();

  constructor(options: CredentialBrokerOptions) {
    this.pluginName = options.pluginName;
    this.config = options.config;
    this.capabilities = options.capabilities;
    this.logger = options.logger;
    this.auditLogger = options.auditLogger;
  }

  getClient<T>(service: string): T | undefined {
    // Return cached client if already created
    if (this.clientCache.has(service)) {
      return this.clientCache.get(service) as T;
    }

    // Check that a factory exists for this service
    const factory = clientFactories.get(service);
    if (!factory) {
      this.logger.warn(
        `credential broker: unknown service "${service}" — no client factory registered`,
      );
      return undefined;
    }

    // Verify the plugin declared "client" access for ALL of the service's credentials
    const serviceEnvs = serviceEnvMapping[service];
    if (!serviceEnvs) return undefined;

    const clientAccessibleEnvs = new Set(
      this.capabilities
        .filter((cap) => cap.access === "client")
        .map((cap) => cap.env),
    );
    const hasClientAccess = serviceEnvs.every((env) =>
      clientAccessibleEnvs.has(env),
    );
    if (!hasClientAccess) {
      this.logger.warn(
        `credential broker: plugin "${this.pluginName}" requested client for "${service}" ` +
          `but did not declare access: "client" for all required credentials`,
      );
      return undefined;
    }

    // Create the client via factory
    const client = factory(this.config, this.logger);
    if (client === undefined) return undefined;

    this.clientCache.set(service, client);

    this.auditLogger?.log({
      plugin: this.pluginName,
      action: "credential.client_created",
      outcome: "allowed",
      details: { service },
    });

    return client as T;
  }

  createAuthenticatedFetch(credentialKey: string): AuthenticatedFetch {
    // Verify the plugin declared "authenticated-fetch" access for this credential
    const cap = this.capabilities.find(
      (c) => c.env === credentialKey && c.access === "authenticated-fetch",
    );
    if (!cap) {
      throw new Error(
        `Plugin "${this.pluginName}" did not declare authenticated-fetch access for "${credentialKey}"`,
      );
    }

    const credential = this.config.get(credentialKey);
    if (!credential) {
      throw new Error(
        `Credential "${credentialKey}" not available for plugin "${this.pluginName}"`,
      );
    }

    const urlPattern = cap.urlPattern;
    const authScheme = cap.authScheme ?? "bearer";

    this.auditLogger?.log({
      plugin: this.pluginName,
      action: "credential.fetch_created",
      outcome: "allowed",
      details: { credentialKey, authScheme, urlPattern: urlPattern ?? "*" },
    });

    return async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = url.toString();

      // Enforce URL pattern if declared
      if (urlPattern && !matchUrlPattern(urlStr, urlPattern)) {
        throw new Error(
          `Request to "${urlStr}" blocked — does not match declared URL pattern "${urlPattern}"`,
        );
      }

      // Build auth header based on declared scheme
      const headers = new Headers(init?.headers);
      switch (authScheme) {
        case "bearer":
          headers.set("Authorization", `Bearer ${credential}`);
          break;
        case "basic": {
          const username = cap.basicUsername
            ? (this.config.get(cap.basicUsername) ?? "")
            : "";
          headers.set(
            "Authorization",
            `Basic ${Buffer.from(`${username}:${credential}`).toString("base64")}`,
          );
          break;
        }
        case "header":
          headers.set(cap.headerName ?? "Authorization", credential);
          break;
      }

      return fetch(urlStr, { ...init, headers });
    };
  }

  getRawCredential(key: string): string | undefined {
    // Verify the plugin declared "raw" access for this credential
    const hasRawAccess = this.capabilities.some(
      (cap) => cap.env === key && cap.access === "raw",
    );
    if (!hasRawAccess) {
      this.auditLogger?.log({
        plugin: this.pluginName,
        action: "credential.raw_denied",
        outcome: "denied",
        details: { credentialKey: key },
      });
      this.logger.warn(
        `credential broker: DENIED raw access to "${key}" for plugin "${this.pluginName}" ` +
          `— not declared with access: "raw"`,
      );
      return undefined;
    }

    const value = this.config.get(key);

    this.auditLogger?.log({
      plugin: this.pluginName,
      action: "credential.raw_access",
      outcome: "allowed",
      details: { credentialKey: key, found: value !== undefined },
    });

    return value;
  }

  hasCredential(key: string): boolean {
    return this.config.has(key);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple URL pattern matching — supports trailing wildcard (e.g., "https://api.github.com/*") */
function matchUrlPattern(url: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return url.startsWith(pattern.slice(0, -1));
  }
  return url === pattern;
}
