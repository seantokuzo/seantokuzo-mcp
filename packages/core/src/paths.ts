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

/** Characters that would inject extra paths into the comma-delimited
 *  `--allow-fs-read=` Node Permission Model arg (round-1 Security advisory).
 *  Refuse to resolve any kuzo path whose env override contains them. */
const FORBIDDEN_ENV_CHARS = [",", "\n"];

/**
 * Read a kuzo-state env override, treating empty-string as unset and
 * rejecting characters that would break the sandbox arg in plugin-process.
 *
 * - `??` semantics would let `KUZO_HOME=""` (easy to leave in a .env or CI
 *   matrix) fall through to `join("", "credentials.enc") === "credentials.enc"`,
 *   landing kuzo state in the user's CWD (often a git repo).
 * - A comma in the value silently widens `--allow-fs-read=` because Node
 *   parses it as a path separator. Newline is in the same category.
 */
function readEnvOverride(name: "KUZO_HOME" | "KUZO_PLUGINS_DIR"): string | undefined {
  const raw = process.env[name];
  if (raw == null || raw.length === 0) return undefined;
  for (const ch of FORBIDDEN_ENV_CHARS) {
    if (raw.includes(ch)) {
      const display = ch === "\n" ? "\\n" : ch;
      throw new Error(
        `${name}=${JSON.stringify(raw)} contains a forbidden character ("${display}"). ` +
          `Comma and newline cannot appear in a kuzo path override — they would ` +
          `inject extra entries into the plugin sandbox's --allow-fs-read=… flag.`,
      );
    }
  }
  return raw;
}

/** State root. `$KUZO_HOME` or `~/.kuzo`. */
export function kuzoHome(): string {
  return readEnvOverride("KUZO_HOME") ?? join(homedir(), ".kuzo");
}

/**
 * Plugins root. `$KUZO_PLUGINS_DIR` if set (highest precedence — preserves the
 * 2.5e parity test which only redirects the plugins tree), otherwise
 * `<kuzoHome>/plugins`.
 */
export function pluginsRoot(): string {
  return readEnvOverride("KUZO_PLUGINS_DIR") ?? join(kuzoHome(), "plugins");
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
