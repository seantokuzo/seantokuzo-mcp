/**
 * Canonical paths for plugin install state.
 *
 * Mirrors spec §C.6 + §D.7:
 *   ~/.kuzo/plugins/                       ← plugins root
 *   ~/.kuzo/plugins/index.json             ← installed-plugins registry
 *   ~/.kuzo/plugins/.lock                  ← exclusive install/update lock
 *   ~/.kuzo/plugins/<name>/current         ← symlink to active version dir
 *   ~/.kuzo/plugins/<name>/<version>/pkg/  ← extracted tarball
 *   ~/.kuzo/plugins/<name>/<version>/node_modules/
 *   ~/.kuzo/plugins/<name>/<version>/verification.json
 *   ~/.kuzo/plugins/<name>/.tmp/           ← staging dir (atomic install)
 *
 * Respects KUZO_PLUGINS_DIR env override (also honored by plugin-resolver
 * in @kuzo-mcp/core, used by the parity test).
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function pluginsRoot(): string {
  return process.env["KUZO_PLUGINS_DIR"] ?? join(homedir(), ".kuzo", "plugins");
}

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
