/**
 * Shared staging primitives for install / update.
 *
 * Both commands share the same shape:
 *   1. Extract pinned tarball into `<name>/.tmp/pkg/`
 *   2. Synthesize a sibling `package.json` so `npm install` resolves transitive
 *      deps next to `pkg/` (per spec §C.6 layout)
 *   3. Run `npm install --ignore-scripts --omit=dev` against the staging dir
 *   4. Dynamic-import `pkg/<entry>` to read the manifest
 *
 * Rollback also needs the manifest loader — it has to re-consent against the
 * target version's declared capabilities, which only exist in code. The loader
 * is generalized to take any `pkgRoot` so it works on staging or a versioned
 * install dir interchangeably.
 *
 * The integrity hash MUST be the verified one (not the user-supplied
 * versionSpec) so pacote rejects any tarball that doesn't match the bytes we
 * verified — closes the verify→extract TOCTOU window per spec §C.9.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { createSpinner } from "nanospinner";
import pacote from "pacote";

import type { KuzoPlugin } from "@kuzo-mcp/types";

import {
  pluginsRoot,
  stagingDir,
  stagingPkgDir,
  versionPkgDir,
} from "./paths.js";
import { ensurePluginsRoot } from "./state.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type StagingErrorCode =
  | "E_EXTRACT_FAILED"
  | "E_DEPS_INSTALL_FAILED"
  | "E_NO_ENTRY_POINT"
  | "E_MANIFEST_LOAD_FAILED"
  | "E_NO_DEFAULT_EXPORT";

/** Thrown by stageTarball / loadPluginManifest. Mapped to exit codes by the caller. */
export class StagingError extends Error {
  readonly code: StagingErrorCode;
  constructor(code: StagingErrorCode, message: string) {
    super(message);
    this.name = "StagingError";
    this.code = code;
  }
}

/**
 * Exit-code mapping owned here so install/update/rollback all honor the same
 * codes when staging fails. 42-44 reserved (matches the install.ts table that
 * shipped in D.1).
 */
export const STAGING_ERROR_EXIT_CODES: Readonly<Record<StagingErrorCode, number>> =
  Object.freeze({
    E_EXTRACT_FAILED: 42,
    E_DEPS_INSTALL_FAILED: 43,
    E_NO_ENTRY_POINT: 44,
    E_MANIFEST_LOAD_FAILED: 44,
    E_NO_DEFAULT_EXPORT: 44,
  });

// ---------------------------------------------------------------------------
// Stage tarball
// ---------------------------------------------------------------------------

/**
 * Extract a tarball into `<name>/.tmp/pkg/` and install transitive deps.
 *
 * `resolvedVersion` + `integrity` MUST come from the verification result, not
 * the user-supplied version spec. pacote will throw if the downloaded tarball
 * doesn't match the integrity hash, which is what closes the TOCTOU window
 * between verifyPackageProvenance and extract.
 *
 * Cleans the staging dir on any failure so the next attempt starts fresh.
 */
export async function stageTarball(
  friendlyName: string,
  pkg: string,
  resolvedVersion: string,
  registry: string,
  integrity: string,
): Promise<void> {
  ensurePluginsRoot();
  const staging = stagingDir(friendlyName);
  if (existsSync(staging)) {
    rmSync(staging, { recursive: true, force: true });
  }
  mkdirSync(staging, { recursive: true });

  const pkgTarget = stagingPkgDir(friendlyName);
  const pinnedSpec = `${pkg}@${resolvedVersion}`;

  const extract = createSpinner(`Extracting ${pinnedSpec}...`).start();
  try {
    // Pin to the exact bytes we verified. `ignoreScripts` is defense-in-depth
    // — pacote.extract does not run scripts today, but the option future-proofs
    // against a pacote behavior change.
    await pacote.extract(pinnedSpec, pkgTarget, {
      registry,
      ...(integrity ? { integrity } : {}),
      ignoreScripts: true,
    });
    extract.success({
      text: `Extracted tarball to ${relative(pluginsRoot(), pkgTarget)}`,
    });
  } catch (err) {
    extract.error({ text: `Extract failed: ${(err as Error).message}` });
    cleanupStaging(friendlyName);
    throw new StagingError(
      "E_EXTRACT_FAILED",
      `Failed to extract tarball: ${(err as Error).message}`,
    );
  }

  // Sibling package.json so `npm install --prefix=<staging>` resolves the
  // plugin's declared deps next to pkg/ (spec §C.6). Merge peer + optional +
  // deps because first-party plugins declare `@kuzo-mcp/types` as a peer
  // (locked-decision #10) and would otherwise fail at runtime.
  const pluginPkgJson = JSON.parse(
    readFileSync(join(pkgTarget, "package.json"), "utf-8"),
  ) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const stagingPkgJson = {
    name: `kuzo-staging-${friendlyName}`,
    version: "0.0.0",
    private: true,
    dependencies: {
      ...(pluginPkgJson.peerDependencies ?? {}),
      ...(pluginPkgJson.optionalDependencies ?? {}),
      ...(pluginPkgJson.dependencies ?? {}),
    },
  };
  writeFileSync(
    join(staging, "package.json"),
    JSON.stringify(stagingPkgJson, null, 2) + "\n",
    "utf-8",
  );

  const deps = createSpinner(
    "Installing transitive deps (scripts disabled)...",
  ).start();
  const result = spawnSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      "--no-package-lock",
      "--no-save",
      "--registry",
      registry,
    ],
    { cwd: staging, stdio: "pipe", encoding: "utf-8" },
  );
  if (result.status !== 0) {
    deps.error({ text: "npm install failed" });
    cleanupStaging(friendlyName);
    throw new StagingError(
      "E_DEPS_INSTALL_FAILED",
      `npm install failed (exit ${String(result.status)}):\n${result.stderr || result.stdout}`,
    );
  }
  deps.success({ text: "Dependencies installed" });
}

/** Best-effort removal of `<name>/.tmp/`. Safe to call when staging is absent. */
export function cleanupStaging(friendlyName: string): void {
  const staging = stagingDir(friendlyName);
  if (existsSync(staging)) {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Manifest loader
// ---------------------------------------------------------------------------

/**
 * Dynamic-import a plugin's entry module and return its default export.
 *
 * `pkgRoot` is the directory containing the plugin's `package.json` — for
 * staging this is `~/.kuzo/plugins/<name>/.tmp/pkg/`; for an installed
 * version (used by rollback) it is `~/.kuzo/plugins/<name>/<version>/pkg/`.
 *
 * The ESM module loader caches by URL, so installs/updates/rollbacks that
 * re-import the same path inside one process would otherwise reuse the first
 * load. The `?staged=<timestamp>` cache-buster forces a fresh module each call.
 */
export async function loadPluginManifest(pkgRoot: string): Promise<KuzoPlugin> {
  const pkgJson = JSON.parse(
    readFileSync(join(pkgRoot, "package.json"), "utf-8"),
  ) as {
    main?: string;
    exports?: { "."?: { import?: string; default?: string } };
  };
  const entry =
    pkgJson.exports?.["."]?.import ??
    pkgJson.exports?.["."]?.default ??
    pkgJson.main;
  if (!entry) {
    throw new StagingError(
      "E_NO_ENTRY_POINT",
      `Plugin package has no entry point (main or exports["."]).`,
    );
  }
  const entryUrl =
    pathToFileURL(join(pkgRoot, entry)).href +
    `?staged=${Date.now().toString()}`;

  let module: Record<string, unknown>;
  try {
    module = (await import(entryUrl)) as Record<string, unknown>;
  } catch (err) {
    throw new StagingError(
      "E_MANIFEST_LOAD_FAILED",
      `Failed to import plugin entry: ${(err as Error).message}`,
    );
  }

  const defaultExport = module["default"];
  if (!defaultExport || typeof defaultExport !== "object") {
    throw new StagingError(
      "E_NO_DEFAULT_EXPORT",
      `Plugin entry must default-export a KuzoPlugin object.`,
    );
  }
  return defaultExport as KuzoPlugin;
}

/** Load the staged manifest for a plugin currently in `<name>/.tmp/`. */
export function loadStagedManifest(friendlyName: string): Promise<KuzoPlugin> {
  return loadPluginManifest(stagingPkgDir(friendlyName));
}

/** Load an installed version's manifest from `<name>/<version>/pkg/`. */
export function loadVersionedManifest(
  friendlyName: string,
  version: string,
): Promise<KuzoPlugin> {
  return loadPluginManifest(versionPkgDir(friendlyName, version));
}
