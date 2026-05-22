/**
 * Canonical paths for plugin install state.
 *
 * Mirrors spec §C.6 + §D.7:
 *   <pluginsRoot>/                       ← plugins root
 *   <pluginsRoot>/index.json             ← installed-plugins registry
 *   <pluginsRoot>/.lock                  ← exclusive install/update lock
 *   <pluginsRoot>/<name>/current         ← symlink to active version dir
 *   <pluginsRoot>/<name>/<version>/pkg/  ← extracted tarball
 *   <pluginsRoot>/<name>/<version>/node_modules/
 *   <pluginsRoot>/<name>/<version>/verification.json
 *   <pluginsRoot>/<name>/.tmp/           ← staging dir (atomic install)
 *
 * `pluginsRoot` (and the `KUZO_HOME` / `KUZO_PLUGINS_DIR` precedence behind it)
 * is owned by `@kuzo-mcp/core/paths`. Re-exported here so callers under
 * `packages/cli/src/commands/plugins/` can keep importing from one place.
 */

import { join } from "node:path";

import { pluginsRoot } from "@kuzo-mcp/core/paths";

export { pluginsRoot };

export function indexJsonPath(): string {
  return join(pluginsRoot(), "index.json");
}

export function lockFilePath(): string {
  return join(pluginsRoot(), ".lock");
}

export function pluginDir(name: string): string {
  return join(pluginsRoot(), name);
}

export function versionDir(name: string, version: string): string {
  return join(pluginDir(name), version);
}

/**
 * Where the extracted package contents live within a versioned install.
 * Mirrors `stagingPkgDir` after the staging→version rename — both point at
 * the `pkg/` subdir that holds package.json + dist/.
 */
export function versionPkgDir(name: string, version: string): string {
  return join(versionDir(name, version), "pkg");
}

export function currentSymlink(name: string): string {
  return join(pluginDir(name), "current");
}

export function stagingDir(name: string): string {
  return join(pluginDir(name), ".tmp");
}

export function stagingPkgDir(name: string): string {
  return join(stagingDir(name), "pkg");
}

export function verificationJsonPath(name: string, version: string): string {
  return join(versionDir(name, version), "verification.json");
}
