/**
 * Consent storage — persists plugin permission grants at ~/.kuzo/consent.json.
 *
 * The MCP server checks consent before loading plugins. The CLI
 * (`kuzo consent`, `kuzo revoke`, `kuzo permissions`) manages grants.
 *
 * Schema matches SECURITY.md §9.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Capability, KuzoPluginV2 } from "@kuzo-mcp/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConsentRecord {
  pluginVersion: string;
  permissionModel: number;
  granted: Capability[];
  denied: Capability[];
  grantedAt: string;
}

export interface ConsentData {
  version: 1;
  plugins: Record<string, ConsentRecord>;
}

// ---------------------------------------------------------------------------
// ConsentStore
// ---------------------------------------------------------------------------

export interface ConsentStoreOptions {
  /** Directory for consent.json (default: ~/.kuzo) */
  consentDir?: string;
}

export class ConsentStore {
  private readonly consentPath: string;
  private data: ConsentData;

  constructor(options: ConsentStoreOptions = {}) {
    const dir = options.consentDir ?? join(homedir(), ".kuzo");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.consentPath = join(dir, "consent.json");
    this.data = this.load();
  }

  /** Get consent record for a plugin, or undefined if not consented */
  getConsent(pluginName: string): ConsentRecord | undefined {
    return this.data.plugins[pluginName];
  }

  /** Check if a plugin has stored consent */
  hasConsent(pluginName: string): boolean {
    return Object.hasOwn(this.data.plugins, pluginName);
  }

  /**
   * Check if a plugin's consent is stale — i.e., the plugin version or
   * capabilities have changed since consent was granted.
   */
  isConsentStale(plugin: KuzoPluginV2): boolean {
    const record = this.data.plugins[plugin.name];
    if (!record) return true;

    // Version changed → re-consent required (open question #6: refuse to load)
    if (record.pluginVersion !== plugin.version) return true;

    // Capabilities changed → re-consent required.
    // Include optional capabilities too — they're part of the permission
    // surface the user reviewed during consent. Compare against the full
    // set (granted + denied) so new capabilities trigger re-consent.
    const currentCaps = capabilityKeys([
      ...plugin.capabilities,
      ...(plugin.optionalCapabilities ?? []),
    ]);
    const consentedCaps = capabilityKeys([...record.granted, ...record.denied]);
    for (const cap of currentCaps) {
      if (!consentedCaps.has(cap)) return true;
    }

    return false;
  }

  /** Grant consent for a plugin */
  grantConsent(
    plugin: KuzoPluginV2,
    granted: Capability[],
    denied: Capability[] = [],
  ): void {
    this.data.plugins[plugin.name] = {
      pluginVersion: plugin.version,
      permissionModel: plugin.permissionModel,
      granted,
      denied,
      grantedAt: new Date().toISOString(),
    };
    this.save();
  }

  /** Revoke all consent for a plugin */
  revokeConsent(pluginName: string): boolean {
    if (!Object.hasOwn(this.data.plugins, pluginName)) return false;
    delete this.data.plugins[pluginName];
    this.save();
    return true;
  }

  /** Revoke a specific capability kind for a plugin */
  revokeCapability(pluginName: string, kind: string): boolean {
    const record = this.data.plugins[pluginName];
    if (!record) return false;

    const before = record.granted.length;
    record.granted = record.granted.filter((c) => c.kind !== kind);
    if (record.granted.length === before) return false;

    // If no capabilities remain, remove the entire record
    if (record.granted.length === 0) {
      delete this.data.plugins[pluginName];
    }

    this.save();
    return true;
  }

  /** List all consent records */
  listAll(): Record<string, ConsentRecord> {
    return { ...this.data.plugins };
  }

  /** Reload from disk (useful after external changes) */
  reload(): void {
    this.data = this.load();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private load(): ConsentData {
    if (!existsSync(this.consentPath)) {
      return { version: 1, plugins: {} };
    }
    try {
      const raw = readFileSync(this.consentPath, "utf-8");
      const parsed = JSON.parse(raw) as ConsentData;
      if (parsed.version !== 1) {
        throw new Error(`Unsupported consent schema version: ${String(parsed.version)}`);
      }
      // Guard against valid JSON with unexpected shape (e.g., plugins: null)
      if (!parsed.plugins || typeof parsed.plugins !== "object" || Array.isArray(parsed.plugins)) {
        throw new Error("Invalid consent.json: plugins must be an object");
      }
      // Sanitize per-plugin records — drop entries with missing/invalid fields
      // so isConsentStale() doesn't throw when spreading granted/denied
      for (const [name, record] of Object.entries(parsed.plugins)) {
        const r = record as ConsentRecord;
        if (!Array.isArray(r.granted) || !Array.isArray(r.denied)) {
          delete parsed.plugins[name];
        }
      }
      return parsed;
    } catch {
      // Corrupted or malformed file — start fresh
      return { version: 1, plugins: {} };
    }
  }

  private save(): void {
    writeFileSync(
      this.consentPath,
      JSON.stringify(this.data, null, 2) + "\n",
      "utf-8",
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a set of capability identity keys for comparison */
function capabilityKeys(caps: Capability[]): Set<string> {
  return new Set(caps.map(capabilityKey));
}

/** Stable identity key for a capability (kind + discriminating field) */
export function capabilityKey(cap: Capability): string {
  switch (cap.kind) {
    case "credentials":
      return `credentials:${cap.env}:${cap.access}`;
    case "network":
      return `network:${cap.domain}`;
    case "filesystem":
      return `filesystem:${cap.path}:${cap.access}`;
    case "cross-plugin":
      return `cross-plugin:${cap.target}`;
    case "system":
      return `system:${cap.operation}:${cap.command ?? "*"}`;
  }
}

/**
 * Diff two capability lists by identity key (see `capabilityKey`).
 *
 * Returns the capability objects from each side — not just their keys — so
 * callers can render human-readable diff lines (kind, target, reason) without
 * re-resolving keys back to caps.
 *
 * Used by `kuzo plugins update` to decide whether a new manifest's capability
 * surface requires re-consent. Subset/equal → silent reuse; any add/remove →
 * surface diff + re-prompt.
 */
export function diffCapabilities(
  next: Capability[],
  prev: Capability[],
): { added: Capability[]; removed: Capability[] } {
  const prevKeys = capabilityKeys(prev);
  const nextKeys = capabilityKeys(next);
  return {
    added: next.filter((cap) => !prevKeys.has(capabilityKey(cap))),
    removed: prev.filter((cap) => !nextKeys.has(capabilityKey(cap))),
  };
}
