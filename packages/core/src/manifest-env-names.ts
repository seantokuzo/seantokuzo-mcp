/**
 * manifest-env-names.ts — Phase 2.6 §C.1 step 5.
 *
 * Synchronously walks all enabled plugins' STATIC manifests
 * (`package.json#kuzoPlugin.capabilities` + `optionalCapabilities`, baked in
 * Theme 0) to collect the union of declared credential env-var names.
 *
 * The result feeds `collectEnvOverrides()` (which reads `process.env` values
 * by name) and `scrubProcessEnv()` (which deletes the matched keys before any
 * plugin entry module is dynamically `import()`-ed).
 *
 * Invariant 6 (§C.1): **no dynamic `import()` of plugin entry modules** before
 * the scrub completes. This walker uses `fs.readFileSync` against
 * `package.json` only — third-party plugins ship arbitrary top-level code,
 * and `import()`-ing them pre-scrub voids the scrub guarantee.
 *
 * Manifest drift (static `kuzoPlugin.capabilities` missing a credential
 * cap that the runtime manifest declares) is not surfaced as a distinct
 * audit code today. First-party plugins are kept in lockstep by Theme 0's
 * `scripts/check-plugin-manifest-parity.mjs` (postbuild + root `pnpm build`
 * chain). Third-party drift will be caught at install time by the §A.12
 * reservation gate in Theme 7. If drift somehow lands at boot, the walker
 * omits the env name, `collectEnvOverrides` misses the value, and the
 * loader's `extractForPlugin` returns `missing: [<env>]` — the plugin is
 * skipped with reason "missing required config" (not a distinct
 * `manifest_drift` event).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { KuzoConfig } from "@kuzo-mcp/types";

import type { KuzoLogger } from "./logger.js";
import { resolvePluginPackageDir } from "./plugin-resolver.js";

/**
 * Kuzo-internal env names a plugin must NOT be allowed to declare as a
 * credential capability. Defense-in-depth: Theme 7's §A.12 reservation
 * gate is the canonical install-time defense; this set is the runtime
 * safety net so a third-party plugin that slips through the install gate
 * (or a first-party plugin that mistakes a kuzo env for a credential)
 * cannot capture these values via `envOverrides` before scrub.
 *
 * Specifically, `KUZO_PASSPHRASE` is the master-key passphrase — a
 * declaration of `{kind: "credentials", env: "KUZO_PASSPHRASE"}` would
 * otherwise route the parent's passphrase straight into the plugin child's
 * credential `Map`. The other entries are runtime knobs the parent reads
 * directly (path overrides, key-provider selection, scrub kill-switch).
 */
const RESERVED_KUZO_ENV: ReadonlySet<string> = new Set([
  "KUZO_PASSPHRASE",
  "KUZO_NO_ENV_SCRUB",
  "KUZO_HOME",
  "KUZO_DISABLE_KEYCHAIN",
  "KUZO_PLUGINS_DIR",
  // Trust-control envs the loader reads at construction time
  // (`loader.ts:49-56`). A plugin declaring any of these as a credential
  // capability would otherwise scrub the value before the loader can read
  // it — self-defeating for an attacker (their own trust gate fails) but
  // confusing UX for an admin who set the var intentionally.
  "KUZO_TRUST_PLUGINS",
  "KUZO_TRUST_ALL",
  "KUZO_TRUST_LEGACY",
  "KUZO_STRICT",
  // Node Permission Model toggle read by plugin-process.ts
  "KUZO_NODE_PERMISSIONS",
]);

interface RawCapability {
  kind?: unknown;
  env?: unknown;
}

interface RawKuzoPluginSection {
  capabilities?: unknown;
  optionalCapabilities?: unknown;
}

interface RawPackageJson {
  kuzoPlugin?: RawKuzoPluginSection;
}

function extractCredentialEnvNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object") continue;
    const cap = item as RawCapability;
    if (cap.kind === "credentials" && typeof cap.env === "string" && cap.env.length > 0) {
      out.push(cap.env);
    }
  }
  return out;
}

/**
 * Read static `package.json#kuzoPlugin` capability env names for every
 * enabled plugin. Failures per plugin are logged and skipped (so one bad
 * plugin can't take down the whole boot); the loader at step 10 is the
 * authoritative error path.
 */
export function collectDeclaredCredentialEnvNames(
  kuzoConfig: KuzoConfig,
  logger?: KuzoLogger,
): Set<string> {
  const declared = new Set<string>();

  for (const [name, conf] of Object.entries(kuzoConfig.plugins)) {
    if (!conf.enabled) continue;

    let packageDir: string;
    try {
      packageDir = resolvePluginPackageDir(name, kuzoConfig);
    } catch (err) {
      logger?.warn(
        `Could not resolve plugin "${name}" package dir for static manifest read: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    let pkgRaw: string;
    try {
      pkgRaw = readFileSync(join(packageDir, "package.json"), "utf-8");
    } catch (err) {
      logger?.warn(
        `Could not read package.json for plugin "${name}" at ${packageDir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(pkgRaw);
    } catch (err) {
      logger?.warn(
        `Could not parse package.json for plugin "${name}" at ${packageDir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    // `JSON.parse("null")` returns `null`; `JSON.parse("42")` returns a number.
    // A degenerate package.json that isn't a JSON object would crash the
    // following property access otherwise — skip it loudly instead.
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger?.warn(
        `Skipping plugin "${name}" — package.json at ${packageDir} did not decode to a JSON object.`,
      );
      continue;
    }
    const pkg = parsed as RawPackageJson;

    const section = pkg.kuzoPlugin;
    if (section == null || typeof section !== "object") continue;

    const addDeclared = (envName: string): void => {
      if (RESERVED_KUZO_ENV.has(envName)) {
        logger?.warn(
          `Plugin "${name}" declared reserved kuzo-internal env name "${envName}" as a credential — ignoring. Theme 7's §A.12 install-time gate is the canonical defense; runtime drop is defense-in-depth.`,
        );
        return;
      }
      declared.add(envName);
    };

    for (const envName of extractCredentialEnvNames(section.capabilities)) {
      addDeclared(envName);
    }
    for (const envName of extractCredentialEnvNames(section.optionalCapabilities)) {
      addDeclared(envName);
    }
  }

  return declared;
}
