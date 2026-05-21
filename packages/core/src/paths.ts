/**
 * Canonical filesystem paths under the kuzo state root (`KUZO_HOME`).
 *
 * Every `~/.kuzo/...` path in the codebase routes through a helper in this
 * file. The lint rule in `eslint.config.js` (Phase 2.6 §E.2) bans inlining
 * `homedir() + ".kuzo"` anywhere else — this is the only file allowed to
 * compose the default home path.
 *
 * Precedence:
 *   `KUZO_HOME`             → state root (consent, audit, credentials, tuf cache, …)
 *   `KUZO_PLUGINS_DIR`      → plugins root only, takes precedence over `KUZO_HOME`
 *                             (preserves the 2.5e parity test, which redirects only
 *                             the plugins tree to a tmpdir.)
 *
 * Defaults to `~/.kuzo/...` when no env override is set — zero behavior change
 * for existing users.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** State root. `$KUZO_HOME` or `~/.kuzo`. */
export function kuzoHome(): string {
  return process.env["KUZO_HOME"] ?? join(homedir(), ".kuzo");
}

/**
 * Plugins root. `$KUZO_PLUGINS_DIR` if set (highest precedence — preserves the
 * 2.5e parity test which only redirects the plugins tree), otherwise
 * `<kuzoHome>/plugins`.
 */
export function pluginsRoot(): string {
  return process.env["KUZO_PLUGINS_DIR"] ?? join(kuzoHome(), "plugins");
}

/** Encrypted credential store (Phase 2.6 Part A). */
export function credentialsFilePath(): string {
  return join(kuzoHome(), "credentials.enc");
}

/** Per-plugin consent grants (Phase 2.5c). */
export function consentFilePath(): string {
  return join(kuzoHome(), "consent.json");
}

/** Structured audit log (Phase 2.5c). */
export function auditFilePath(): string {
  return join(kuzoHome(), "audit.log");
}

/** Sigstore TUF cache directory (Phase 2.5e Part C). */
export function tufCacheDir(): string {
  return join(kuzoHome(), "tuf-cache");
}

/** Cached npm attestations (Phase 2.5e Part D follow-up). */
export function attestationsCacheDir(): string {
  return join(kuzoHome(), "attestations-cache");
}

/** Shared write-op lock for the home dir (Phase 2.6 credentials writes). */
export function kuzoHomeLockPath(): string {
  return join(kuzoHome(), ".lock");
}
