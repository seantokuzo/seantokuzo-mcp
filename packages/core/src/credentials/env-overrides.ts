/**
 * env-overrides.ts — Phase 2.6 §A.7 — process.env credential collection + scrub.
 *
 * Two pure functions, no DI, no class. The Theme 4 boot sequence calls
 * `collectEnvOverrides()` after the manifest read (synchronous walk over
 * `package.json#kuzoPlugin.capabilities`) and `scrubProcessEnv()` immediately
 * after, BEFORE any plugin entry module is `import()`-ed (see §C.1 invariant 6
 * + §C.9 ESLint rule banning `child_process` outside the allowed core paths).
 */

import type { AuditLogger } from "../audit.js";

const KUZO_TOKEN_PREFIX = "KUZO_TOKEN_";

/**
 * Always-scrubbed names — independent of the declared credential set and
 * independent of the `KUZO_NO_ENV_SCRUB` kill-switch.
 *
 * - `KUZO_PASSPHRASE` is the master-key passphrase; never reachable by plugins.
 * - `KUZO_NO_ENV_SCRUB` is the kill-switch itself; scrubbing it means plugin
 *   children spawned later cannot observe the parent's choice to skip scrub
 *   (round-4 A2).
 */
const ALWAYS_SCRUB = ["KUZO_PASSPHRASE", "KUZO_NO_ENV_SCRUB"] as const;

/**
 * Collect credential values supplied via `process.env`.
 *
 * Two supported patterns, both yielding entries keyed by the declared env-var
 * name (the same string the plugin's `CredentialCapability.env` field carries):
 *
 *   - Legacy plain names — e.g. `GITHUB_TOKEN`, `JIRA_API_TOKEN` — read
 *     directly when the name matches one of `declaredEnvNames`.
 *   - Explicit kuzo-namespace override — `KUZO_TOKEN_<NAME>` (gh-CLI-style).
 *
 * Both are valid; `KUZO_TOKEN_<NAME>` wins if both are set (more explicit
 * intent). Empty-string values are treated as not-set, matching the legacy
 * `ConfigManager.extractPluginConfig` `if (value)` truthiness contract — a
 * blank token is functionally equivalent to no token for our auth flows.
 *
 * `declaredEnvNames` is the union of `CredentialCapability.env` strings across
 * all enabled plugin manifests, read synchronously off
 * `package.json#kuzoPlugin.capabilities` at boot (see Theme 4 boot).
 */
export function collectEnvOverrides(
  declaredEnvNames: ReadonlySet<string>,
): Record<string, string> {
  const out: Record<string, string> = {};

  // Plain declared names.
  for (const name of declaredEnvNames) {
    const v = process.env[name];
    if (v) out[name] = v;
  }

  // KUZO_TOKEN_<NAME> pattern — overrides plain. We walk process.env once
  // (not iterating declaredEnvNames again) so unrelated KUZO_TOKEN_* entries
  // that aren't declared still land in `out` — Theme 4's loader will then
  // reject any out-key not in declaredEnvNames per §A.12 reservation.
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith(KUZO_TOKEN_PREFIX) && v) {
      const target = k.slice(KUZO_TOKEN_PREFIX.length);
      out[target] = v;
    }
  }

  return out;
}

/** Discriminants returned by `scrubProcessEnv` for caller-side audit emit. */
export interface ScrubProcessEnvResult {
  /** True iff `KUZO_NO_ENV_SCRUB=1` was set when scrub ran. */
  killSwitchActive: boolean;
  /**
   * Number of env keys that were actually present and deleted. Includes both
   * the declared name and its `KUZO_TOKEN_<NAME>` twin if both were set;
   * always counts `ALWAYS_SCRUB` entries that were present.
   */
  scrubbedCount: number;
}

/**
 * Delete the matched keys from `process.env` so plugin code loaded later
 * (and its forked children) cannot read them directly. Plugins receive
 * credentials through the broker `Map`, never via env.
 *
 * No-ops on declared keys when `KUZO_NO_ENV_SCRUB=1` (kill-switch); the
 * `ALWAYS_SCRUB` entries are deleted regardless. `KUZO_NO_ENV_SCRUB` itself
 * is in `ALWAYS_SCRUB`, so plugin children never see the kill-switch state
 * (round-4 A2).
 *
 * Returns `{killSwitchActive, scrubbedCount}` so callers can audit-emit
 * `credential.scrub_disabled` with the correct reason. The `auditLogger` is
 * threaded as an argument rather than via a constructor so this remains a
 * pure function — boot-step ordering relies on it being callable before any
 * DI / class instance is set up.
 */
export function scrubProcessEnv(
  scrubKeys: readonly string[],
  auditLogger?: AuditLogger,
): ScrubProcessEnvResult {
  const killSwitchActive = process.env.KUZO_NO_ENV_SCRUB === "1";

  const targets = killSwitchActive
    ? new Set<string>(ALWAYS_SCRUB)
    : new Set<string>([...scrubKeys, ...ALWAYS_SCRUB]);

  let scrubbedCount = 0;
  for (const key of targets) {
    if (process.env[key] !== undefined) scrubbedCount++;
    delete process.env[key];

    // The `KUZO_TOKEN_<NAME>` prefix is meaningful only for declared credential
    // names — skip the prefix-delete for ALWAYS_SCRUB entries (they're
    // system/meta names, not credential targets; round-4 nit N1). We still
    // count the twin into `scrubbedCount` only if it was actually present.
    if (!(ALWAYS_SCRUB as readonly string[]).includes(key)) {
      const twin = `${KUZO_TOKEN_PREFIX}${key}`;
      if (process.env[twin] !== undefined) scrubbedCount++;
      delete process.env[twin];
    }
  }

  // Round-4 B11: audit the kill-switch path here, not at the call site, so
  // both kill-switch surfaces (env-var here and the `--no-scrub` CLI flag in
  // Theme 4's §C.1 boot) route through one emit shape. The CLI flag passes
  // its own logger and reason via the boot wiring; here the reason is the
  // env-var.
  if (killSwitchActive && auditLogger) {
    auditLogger.log({
      plugin: "kuzo",
      action: "credential.scrub_disabled",
      outcome: "allowed",
      details: {
        reason: "KUZO_NO_ENV_SCRUB=1",
        declared_skipped: scrubKeys.length,
      },
    });
  }

  return { killSwitchActive, scrubbedCount };
}
