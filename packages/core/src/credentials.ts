/**
 * Credential broker — secure credential access for plugins.
 *
 * Plugins receive pre-authenticated clients or scoped fetch wrappers
 * instead of raw tokens. Raw access is an audited escape hatch.
 *
 * Each plugin runs its own broker instance in its own child process (2.5d
 * isolation). First-party defaults (`github`, `jira`) are pre-loaded into
 * every broker at construction. Third-party plugins extend their own broker
 * via `registerClientFactory` (spec §C.4) — first-party names are
 * write-locked.
 *
 * No module-scope state. Construction takes an optional `clientFactories`
 * override (test seam) — production code uses the built-in defaults.
 */

import type {
  AuthenticatedFetch,
  CredentialBroker,
  CredentialCapability,
  PluginLogger,
} from "@kuzo-mcp/types";
import type { AuditLogger } from "./audit.js";
import { GitHubClient } from "@kuzo-mcp/plugin-github/client";
import { JiraClient } from "@kuzo-mcp/plugin-jira/client";

// ---------------------------------------------------------------------------
// Client factories — first-party defaults
// ---------------------------------------------------------------------------

type ClientFactory = (
  config: Map<string, string>,
  logger: PluginLogger,
) => unknown | undefined;

/**
 * First-party services keyed by their canonical name. Pre-loaded into every
 * `DefaultCredentialBroker` instance at construction so each plugin's broker
 * has its own copy (no shared mutable state across child processes).
 *
 * Third-party plugins MUST NOT re-register these names — `registerClientFactory`
 * throws. Adding a new first-party service is a deliberate change here +
 * `FIRST_PARTY_SERVICE_ENVS` below + the broker's hardcoded import.
 */
const FIRST_PARTY_FACTORIES: ReadonlyMap<string, ClientFactory> = new Map<
  string,
  ClientFactory
>([
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

/**
 * For each first-party service, the env vars the factory reads from `config`.
 * Used by `getClient` to enforce that the plugin declared `access: "client"`
 * for ALL of the service's credentials — a manifest-contract check that's
 * independent of factory behaviour. Third-party services skip this check
 * (the factory itself decides which envs to read and returns `undefined`
 * on missing creds).
 */
const FIRST_PARTY_SERVICE_ENVS: Readonly<Record<string, readonly string[]>> = {
  github: ["GITHUB_TOKEN"],
  jira: ["JIRA_HOST", "JIRA_EMAIL", "JIRA_API_TOKEN"],
};

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
  /**
   * Override the first-party client factory map (test seam — production
   * code should not pass this). When omitted the broker is pre-loaded
   * with `FIRST_PARTY_FACTORIES`.
   */
  clientFactories?: ReadonlyMap<string, ClientFactory>;
}

export class DefaultCredentialBroker implements CredentialBroker {
  private readonly pluginName: string;
  /** Scoped config map. Swapped wholesale by `replaceConfigAtomically` on a
   *  parent-pushed credential refresh (§C.11) — not `readonly`. */
  private config: Map<string, string>;
  private readonly capabilities: CredentialCapability[];
  private readonly logger: PluginLogger;
  private readonly auditLogger: AuditLogger | undefined;
  /**
   * Instance-owned factory map. Pre-loaded from `FIRST_PARTY_FACTORIES`;
   * extended by `registerClientFactory`. Cleared by `shutdown()`.
   *
   * Per-instance Map (NOT module-scope per round-4 advisory A1) so each
   * child process's broker is independently testable and tear-down
   * affects only this plugin's process.
   */
  private readonly clientFactories: Map<string, ClientFactory>;
  private readonly clientCache = new Map<string, unknown>();

  constructor(options: CredentialBrokerOptions) {
    this.pluginName = options.pluginName;
    this.config = options.config;
    this.capabilities = options.capabilities;
    this.logger = options.logger;
    this.auditLogger = options.auditLogger;
    // Construction-time enforcement of the first-party reservation set
    // (round-1 Security advisory A1). `registerClientFactory` already
    // write-locks the reserved names at runtime; this gate makes the
    // SAME invariant self-enforcing on the constructor path so a future
    // caller cannot launder a malicious "github" / "jira" factory
    // through the `options.clientFactories` test-seam. The throw is
    // belt-and-suspenders — no production caller passes the option
    // today, but the safety net is now structural, not conventional.
    if (options.clientFactories) {
      for (const reserved of FIRST_PARTY_FACTORIES.keys()) {
        if (options.clientFactories.has(reserved)) {
          throw new Error(
            `DefaultCredentialBroker: clientFactories override cannot redefine first-party service "${reserved}". ` +
              `Reserved services (${[...FIRST_PARTY_FACTORIES.keys()].join(", ")}) are write-locked.`,
          );
        }
      }
    }
    // Seed from either the override (tests, post-guard) or the first-party
    // defaults. `new Map(iterable)` copies entries — mutating
    // `this.clientFactories` never touches the source.
    this.clientFactories = new Map(options.clientFactories ?? FIRST_PARTY_FACTORIES);
  }

  registerClientFactory<T>(
    service: string,
    factory: (config: Map<string, string>, logger: PluginLogger) => T | undefined,
  ): void {
    if (FIRST_PARTY_FACTORIES.has(service)) {
      throw new Error(
        `Plugin "${this.pluginName}" cannot override first-party client factory for "${service}". ` +
          `First-party services (${[...FIRST_PARTY_FACTORIES.keys()].join(", ")}) are reserved.`,
      );
    }
    if (this.clientFactories.has(service)) {
      // Idempotent: re-registering the same (plugin, service) pair is a no-op.
      // Silent to avoid log noise — call site may legitimately retry during
      // initialize() after a transient setup failure.
      return;
    }
    // No cast needed: `(config, logger) => T | undefined` is assignable to
    // `(config, logger) => unknown` via return-type covariance. Removing
    // the previous `as ClientFactory` surfaces real future signature drift
    // as a type error instead of silently swallowing it (round-4
    // Correctness advisory).
    this.clientFactories.set(service, factory);
  }

  getClient<T>(service: string): T | undefined {
    if (this.clientCache.has(service)) {
      return this.clientCache.get(service) as T;
    }

    const factory = this.clientFactories.get(service);
    if (!factory) {
      this.logger.warn(
        `credential broker: unknown service "${service}" — no client factory registered`,
      );
      return undefined;
    }

    // Enforce the "all declared with access:client" manifest contract for
    // first-party services. Third-party factories DELIBERATELY skip this
    // check (spec §C.4) — the plugin author owns the
    // manifest↔factory parity for their own service. A third-party plugin
    // that declares `access: "raw"` for its token and then registers a
    // factory that builds a client from the same env is lying to its own
    // manifest; the consequence is self-contained (the loader scoped the
    // config Map by env-name, not by access mode — no cross-trust
    // escalation). The consent UI surfaces declared access modes to the
    // user; that is the user-facing line of defense, not this code path.
    // See `CredentialBroker.registerClientFactory` JSDoc for the contract.
    const firstPartyEnvs = FIRST_PARTY_SERVICE_ENVS[service];
    if (firstPartyEnvs) {
      const clientAccessibleEnvs = new Set(
        this.capabilities
          .filter((cap) => cap.access === "client")
          .map((cap) => cap.env),
      );
      const hasClientAccess = firstPartyEnvs.every((env) => clientAccessibleEnvs.has(env));
      if (!hasClientAccess) {
        this.logger.warn(
          `credential broker: plugin "${this.pluginName}" requested client for "${service}" ` +
            `but did not declare access: "client" for all required credentials`,
        );
        return undefined;
      }
    }

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

  /**
   * Swap the scoped config map after a parent-pushed credential refresh
   * (spec §C.11 — rotation cache invalidation). The parent's directory-watch
   * re-resolves this plugin's credentials and sends the new Map over IPC;
   * `plugin-host.ts` calls this. Clearing `clientCache` forces the next
   * `getClient(...)` to rebuild its client with the rotated value.
   *
   * Already-constructed clients that a plugin stashed in its OWN state (not
   * going through `getClient` on each call) are NOT reached — this is the
   * partial mitigation documented in §C.11/§F.4. First-party plugins go
   * through `getClient` per tool-call, so their clients DO pick up the
   * rotation on the next call.
   */
  replaceConfigAtomically(newConfig: Map<string, string>): void {
    this.config = newConfig;
    this.clientCache.clear();
  }

  /**
   * Drop per-plugin scoped state (spec §C.5 child-side scrub). Called from
   * `plugin-host.ts` AFTER `plugin.shutdown()` and BEFORE `process.exit`.
   *
   * Honest scope (R13): V8 strings can't be overwritten in place, so
   * `Map.clear()` just drops references — the underlying UTF-16 buffers
   * remain reachable until GC. The win is that simple heap-traversal tools
   * stop finding live references; a determined attacker scanning raw heap
   * pages can still surface unreachable strings until GC reclaims them.
   *
   * Master-key buffers are wiped in the PARENT via `EncryptedCredentialStore.close`
   * (which calls `keyProvider.wipeKeyCache?.()` — that path IS a real
   * `Buffer.fill(0)` zero). The child never holds the master key.
   */
  shutdown(): void {
    this.config.clear();
    this.clientFactories.clear();
    this.clientCache.clear();
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
