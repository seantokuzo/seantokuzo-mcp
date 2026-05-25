/**
 * Filesystem bootstrap for the kuzo home dir (spec §B.6 R28).
 *
 * Split so a credentials-only operation (`kuzo credentials set` on a brand-new
 * install with no plugins) does NOT auto-create `~/.kuzo/plugins/`. Credentials
 * commands call {@link ensureKuzoHome}; plugin commands call
 * {@link ensurePluginsRoot}.
 */

import { mkdirSync } from "node:fs";

import { kuzoHome, pluginsRoot } from "@kuzo-mcp/core/paths";

/** Create `~/.kuzo/` (mode 0700) if it doesn't exist. Idempotent. */
export function ensureKuzoHome(): void {
  mkdirSync(kuzoHome(), { recursive: true, mode: 0o700 });
}

/** Create `~/.kuzo/plugins/` (mode 0700), home dir included. Idempotent. */
export function ensurePluginsRoot(): void {
  ensureKuzoHome();
  mkdirSync(pluginsRoot(), { recursive: true, mode: 0o700 });
}
