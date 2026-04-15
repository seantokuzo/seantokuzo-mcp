/**
 * Plugin entry resolution.
 *
 * Maps friendly plugin names (as used in kuzo.config.ts) to scoped npm package
 * names, then resolves them to a file:// URL that can be imported. Supports
 * two modes:
 *
 *   1. Installed mode — ~/.kuzo/plugins/<name>/node_modules/<pkg>/ (Part D)
 *   2. Dev mode       — pnpm workspace symlink via import.meta.resolve
 *
 * The friendly-name → package-name mapping for built-ins is a hardcoded map,
 * not config-driven, because that decoupling is a security property: config
 * can never be coerced into pointing a built-in name at an arbitrary package.
 * Third-party plugins declare `packageName` in their own PluginConfig entry.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { pathToFileURL } from "url";
import type { KuzoConfig } from "@kuzo-mcp/types";

/** Hardcoded friendly-name → package-name map for built-in plugins */
export const BUILTIN_PLUGINS: Readonly<Record<string, string>> = Object.freeze({
  "git-context": "@kuzo-mcp/plugin-git-context",
  "github": "@kuzo-mcp/plugin-github",
  "jira": "@kuzo-mcp/plugin-jira",
});

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
 * Resolve a plugin's friendly name to a file:// URL for the module entry.
 * Prefers installed-mode if the plugin has been installed via `kuzo plugins
 * install`, otherwise falls back to dev-mode workspace resolution.
 */
export function resolvePluginEntry(
  name: string,
  kuzoConfig: KuzoConfig,
): string {
  const pkg = BUILTIN_PLUGINS[name] ?? kuzoConfig.plugins[name]?.packageName;
  if (!pkg) {
    throw new Error(
      `Unknown plugin "${name}" — not a built-in and no packageName in config.`,
    );
  }

  // 1. Installed-mode lookup
  const installedRoot =
    process.env["KUZO_PLUGINS_DIR"] ?? join(homedir(), ".kuzo", "plugins");
  const installedPath = join(installedRoot, name, "node_modules", pkg);
  if (existsSync(join(installedPath, "package.json"))) {
    return pathToFileURL(join(installedPath, readMainEntry(installedPath))).href;
  }

  // 2. Dev-mode fallback via workspace symlink
  return import.meta.resolve(pkg);
}
