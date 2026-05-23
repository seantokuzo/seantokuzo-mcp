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

    let pkg: RawPackageJson;
    try {
      pkg = JSON.parse(pkgRaw) as RawPackageJson;
    } catch (err) {
      logger?.warn(
        `Could not parse package.json for plugin "${name}" at ${packageDir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    const section = pkg.kuzoPlugin;
    if (section == null || typeof section !== "object") continue;

    for (const envName of extractCredentialEnvNames(section.capabilities)) {
      declared.add(envName);
    }
    for (const envName of extractCredentialEnvNames(section.optionalCapabilities)) {
      declared.add(envName);
    }
  }

  return declared;
}
