/**
 * Plugin entry resolution.
 *
 * Maps friendly plugin names (as used in kuzo.config.ts) to scoped npm package
 * names, then resolves them to a file:// URL that can be imported. Supports
 * three resolution modes, tried in order:
 *
 *   1. Versioned install (Part D) — ~/.kuzo/plugins/<name>/current/pkg/
 *      The active-version symlink produced by `kuzo plugins install`. Sibling
 *      node_modules/ carries transitive deps.
 *   2. Flat install (parity test) — ~/.kuzo/plugins/<name>/node_modules/<pkg>/
 *      Structure `npm install <tarball>` produces; used by the dev-to-install
 *      parity script until it's migrated to the versioned layout.
 *   3. Dev mode — pnpm workspace symlink via import.meta.resolve.
 *
 * The friendly-name → package-name mapping for built-ins is a hardcoded map,
 * not config-driven, because that decoupling is a security property: config
 * can never be coerced into pointing a built-in name at an arbitrary package.
 * Third-party plugins declare `packageName` in their own PluginConfig entry.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import type { KuzoConfig } from "@kuzo-mcp/types";

import { pluginsRoot } from "./paths.js";

/** Hardcoded friendly-name → package-name map for built-in plugins */
export const BUILTIN_PLUGINS: Readonly<Record<string, string>> = Object.freeze({
  "git-context": "@kuzo-mcp/plugin-git-context",
  "github": "@kuzo-mcp/plugin-github",
  "jira": "@kuzo-mcp/plugin-jira",
});

/**
 * Friendly plugin names become path segments under `pluginsRoot()` (e.g.
 * `<root>/<name>/current/pkg`). This regex guards every `join(root, name, …)`
 * against traversal (`..`, absolute paths, separators) and shell-meta names.
 * Theme-4 round-4 deferred advisory.
 */
const SAFE_PLUGIN_NAME = /^[a-z][a-z0-9-]{0,62}$/;

/** Throw unless `name` is a safe single path segment for the plugins dir. */
export function assertSafePluginName(name: string): void {
  if (!SAFE_PLUGIN_NAME.test(name)) {
    throw new Error(
      `Invalid plugin name "${name}": must match ${SAFE_PLUGIN_NAME.source} ` +
        `(lowercase, letter-led, digits and hyphens only). This guards the plugins ` +
        `directory against path traversal.`,
    );
  }
}

/** Read the `main` entry from an installed package's package.json */
function readMainEntry(packageRoot: string): string {
  const pkgJsonPath = join(packageRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
    main?: string;
    exports?: { "."?: { import?: string; default?: string } };
  };
  const entry =
    pkg.exports?.["."]?.import ??
    pkg.exports?.["."]?.default ??
    pkg.main;
  if (!entry) {
    throw new Error(
      `Package at ${packageRoot} has no resolvable entry point (main or exports["."]).`,
    );
  }
  return entry;
}

/**
 * Resolve a plugin's friendly name to the absolute directory that contains
 * its `package.json`. Phase 2.6 Theme 4 uses this to read static
 * `kuzoPlugin.capabilities` BEFORE any plugin entry module is dynamically
 * imported (spec §C.1 invariant 6 — manifest-import-before-scrub is forbidden).
 *
 * Same three-tier resolution as `resolvePluginEntry`:
 *   1. Versioned install — `<root>/<name>/current/pkg/`
 *   2. Flat install      — `<root>/<name>/node_modules/<pkg>/`
 *   3. Dev mode          — walk up from `import.meta.resolve(pkg)` until a
 *                          `package.json` is found (handles arbitrary plugin
 *                          layouts without assuming `dist/index.js`).
 */
export function resolvePluginPackageDir(
  name: string,
  kuzoConfig: KuzoConfig,
): string {
  assertSafePluginName(name);
  const pkg = BUILTIN_PLUGINS[name] ?? kuzoConfig.plugins[name]?.packageName;
  if (!pkg) {
    throw new Error(
      `Unknown plugin "${name}" — not a built-in and no packageName in config.`,
    );
  }

  const installedRoot = pluginsRoot();

  const versionedPath = join(installedRoot, name, "current", "pkg");
  if (existsSync(join(versionedPath, "package.json"))) return versionedPath;

  const flatPath = join(installedRoot, name, "node_modules", pkg);
  if (existsSync(join(flatPath, "package.json"))) return flatPath;

  const entryUrl = import.meta.resolve(pkg);
  const entryPath = fileURLToPath(entryUrl);
  let dir = dirname(entryPath);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error(
    `Could not resolve package directory for plugin "${name}" (package "${pkg}"): no package.json found above ${entryPath}.`,
  );
}

/**
 * Resolve a plugin's friendly name to a file:// URL for the module entry.
 * Prefers installed-mode if the plugin has been installed via `kuzo plugins
 * install`, otherwise falls back to dev-mode workspace resolution.
 */
export function resolvePluginEntry(
  name: string,
  kuzoConfig: KuzoConfig,
): string {
  assertSafePluginName(name);
  const pkg = BUILTIN_PLUGINS[name] ?? kuzoConfig.plugins[name]?.packageName;
  if (!pkg) {
    throw new Error(
      `Unknown plugin "${name}" — not a built-in and no packageName in config.`,
    );
  }

  const installedRoot = pluginsRoot();

  // 1. Versioned install (Part D): <root>/<name>/current/pkg/
  const versionedPath = join(installedRoot, name, "current", "pkg");
  if (existsSync(join(versionedPath, "package.json"))) {
    return pathToFileURL(join(versionedPath, readMainEntry(versionedPath))).href;
  }

  // 2. Flat install (parity test): <root>/<name>/node_modules/<pkg>/
  const flatPath = join(installedRoot, name, "node_modules", pkg);
  if (existsSync(join(flatPath, "package.json"))) {
    return pathToFileURL(join(flatPath, readMainEntry(flatPath))).href;
  }

  // 3. Dev-mode fallback via workspace symlink
  return import.meta.resolve(pkg);
}
