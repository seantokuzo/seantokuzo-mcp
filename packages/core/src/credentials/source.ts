/**
 * source.ts — Phase 2.6 §A.6 — `CredentialSource`.
 *
 * Lookup credentials by env-var name, with env-override precedence over the
 * encrypted store. Used by the Theme 4 loader rewrite to build the per-plugin
 * scoped credential `Map` that `DefaultCredentialBroker` consumes (the broker
 * interface itself is unchanged from 2.5b).
 *
 * Pure logic — no I/O, no boot wiring. The `CredentialStore` is injected; the
 * env-overrides `Record` is produced by `collectEnvOverrides()` in
 * `./env-overrides.ts` from the union of declared `CredentialCapability.env`
 * values across enabled plugin manifests.
 *
 * `extractForPlugin` is a drop-in replacement for the legacy
 * `ConfigManager.extractPluginConfig(required, optional)` — same calling shape,
 * same return shape. Theme 4 swaps the loader call site.
 */

import type { CredentialCapability } from "@kuzo-mcp/types";
import type { CredentialStore } from "./store.js";

/**
 * A plugin's declared credential capabilities, split required-vs-optional.
 * The single named shape threaded loader → `PluginProcess.declaredCapabilities`
 * → `CredentialSource.extractForPlugin` (also re-resolved by the §C.11 rotation
 * watcher). Centralized here to prevent drift across those call sites.
 */
export interface DeclaredCredentialCapabilities {
  required: readonly CredentialCapability[];
  optional: readonly CredentialCapability[];
}

export class CredentialSource {
  constructor(
    private readonly store: CredentialStore,
    private readonly envOverrides: Record<string, string>,
  ) {}

  /**
   * Get a value: env override wins, then store, then undefined.
   *
   * `Object.hasOwn` (not `in` / not truthiness check) so that a future caller
   * who needs to express "this key is intentionally empty" via `""` works
   * correctly — empty string ≠ undefined ≠ missing key.
   */
  get(key: string): string | undefined {
    if (Object.hasOwn(this.envOverrides, key)) return this.envOverrides[key];
    return this.store.get(key);
  }

  /**
   * Whether the key has a value from any source.
   *
   * Note on store lookup: `CredentialStore.has()` reports the in-memory cache
   * and returns `false` on a never-unlocked store. The Theme 4 boot path is
   * parent-eager-decrypt — the store is unlocked during `loader.loadAll()`
   * before any `CredentialSource.has()` call, so this is a safe lookup in
   * practice. Callers outside the boot path that need a definitive answer
   * before unlock should call `get()` first.
   */
  has(key: string): boolean {
    return Object.hasOwn(this.envOverrides, key) || this.store.has(key);
  }

  /**
   * Extract credential values for a plugin from its declared capabilities.
   *
   * `required` caps with no value populate `missing`; `optional` caps with no
   * value are silently omitted (plugin sees `undefined` when it asks for them
   * via `config.get(...)`). The `CredentialCapability` interface itself does
   * NOT carry an `optional?` field — required-vs-optional is captured by which
   * manifest array the cap came from (round-4 B4 — locks the no-schema-change
   * decision in Q10).
   *
   * Calling shape mirrors `ConfigManager.extractPluginConfig(required, optional)`
   * so the Theme 4 loader switchover is mechanical.
   */
  extractForPlugin(
    args: DeclaredCredentialCapabilities,
  ): { config: Map<string, string>; missing: string[] } {
    const config = new Map<string, string>();
    const missing: string[] = [];

    for (const cap of args.required) {
      const value = this.get(cap.env);
      if (value !== undefined) {
        config.set(cap.env, value);
      } else {
        missing.push(cap.env);
      }
    }

    for (const cap of args.optional) {
      const value = this.get(cap.env);
      if (value !== undefined) {
        config.set(cap.env, value);
      }
      // optional + missing: silent omission, plugin handles undefined itself.
    }

    return { config, missing };
  }
}
