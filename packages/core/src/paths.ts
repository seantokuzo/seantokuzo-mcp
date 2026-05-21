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
 *  Comma is the path separator; newline likewise breaks any single-arg parser. */
const FORBIDDEN_FS_ARG_CHARS = [",", "\n"];

/**
 * Refuse to use `path` as an `--allow-fs-read=` argument if it contains a
 * character that would inject extra paths into the comma-delimited list.
 *
 * Applied both to env-supplied kuzo paths (`KUZO_HOME` / `KUZO_PLUGINS_DIR`)
 * and to any other path that gets interpolated into the sandbox arg (see
 * `plugin-process.ts` for the call site).
 */
export function assertNoFsArgInjection(path: string, label: string): void {
  for (const ch of FORBIDDEN_FS_ARG_CHARS) {
    if (path.includes(ch)) {
      const display = ch === "\n" ? "\\n" : ch;
      throw new Error(
        `${label}=${JSON.stringify(path)} contains a forbidden character ("${display}"). ` +
          `Comma and newline cannot appear in a path used as a --allow-fs-read=… argument — ` +
          `they would inject extra entries into the plugin sandbox.`,
      );
    }
  }
}

/**
 * Read a kuzo-state env override, treating empty-string as unset and
 * rejecting characters that would break the sandbox arg in plugin-process.
 *
 * `??` semantics would let `KUZO_HOME=""` (easy to leave in a .env or CI
 * matrix) fall through to `join("", "credentials.enc") === "credentials.enc"`,
 * landing kuzo state in the user's CWD (often a git repo).
 */
function readEnvOverride(name: "KUZO_HOME" | "KUZO_PLUGINS_DIR"): string | undefined {
  const raw = process.env[name];
  if (raw == null || raw.length === 0) return undefined;
  assertNoFsArgInjection(raw, name);
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
