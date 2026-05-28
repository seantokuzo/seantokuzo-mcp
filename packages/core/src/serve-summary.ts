/**
 * serve-summary.ts — Phase 2.6 §D.3 first-run UX.
 *
 * Builds the stderr ready-summary `runServer()` emits once the MCP transport
 * connects. Pure string logic (no I/O) so the branchy first-run / upgrade-nudge
 * cases are unit-testable. stdout is the MCP protocol — every line here is
 * written to stderr by the caller.
 */

import type { LoadResult } from "@kuzo-mcp/types";

const PREFIX = "[kuzo]";

/** The loader's skip reason for credential-less plugins (loader.ts). */
const MISSING_CONFIG_PREFIX = "missing required config: ";

export interface ServeSummaryInput {
  loadResult: LoadResult;
  /** Credential env-override names present at boot (`collectEnvOverrides` keys). */
  envOverrideNames: readonly string[];
  /** Stored credential count (`credentialStore.size` — 0 if never unlocked). */
  storeSize: number;
  /** `KUZO_NO_MIGRATE_NUDGE` set → suppress the R35 upgrade banner. */
  suppressMigrateNudge: boolean;
}

/**
 * Build the §D.3 ready-summary lines (no trailing newlines — the caller joins
 * with `\n` to stderr).
 */
export function buildServeSummary(input: ServeSummaryInput): string[] {
  const { loadResult, envOverrideNames, storeSize, suppressMigrateNudge } = input;
  const lines: string[] = [];

  lines.push(
    `${PREFIX} ready — ${loadResult.loaded.length} plugins loaded, ${loadResult.skipped.length} skipped`,
  );

  for (const name of loadResult.loaded) {
    lines.push(`${PREFIX} ${name}: OK`);
  }

  let anyMissingCreds = false;
  for (const skip of loadResult.skipped) {
    if (skip.reason.startsWith(MISSING_CONFIG_PREFIX)) {
      anyMissingCreds = true;
      const names = skip.reason.slice(MISSING_CONFIG_PREFIX.length);
      lines.push(`${PREFIX} ${skip.name}: SKIPPED — missing credentials (${names})`);
    } else {
      lines.push(`${PREFIX} ${skip.name}: SKIPPED — ${skip.reason}`);
    }
  }

  const noCredsAnywhere = envOverrideNames.length === 0 && storeSize === 0;

  if (noCredsAnywhere) {
    // Brand-new install: nothing in env, nothing stored.
    lines.push(
      `${PREFIX} No credentials configured. Plugins requiring credentials will be skipped.`,
    );
    lines.push(
      `${PREFIX} To configure: \`kuzo credentials set GITHUB_TOKEN\` (or \`kuzo credentials migrate\` to import from existing config).`,
    );
  } else if (anyMissingCreds) {
    lines.push(`${PREFIX} Run \`kuzo credentials set <name>\` to configure.`);
  }

  // R35 upgrade nudge: env creds present but the store is empty → suggest
  // migrating to the encrypted store. Mutually exclusive with the zero-cred
  // message above (that needs zero env overrides). Suppressed for deliberate
  // env-override-only use (CI / `op run` / etc.) via KUZO_NO_MIGRATE_NUDGE.
  if (!suppressMigrateNudge && envOverrideNames.length > 0 && storeSize === 0) {
    lines.push(`${PREFIX} Detected unencrypted credentials in your environment.`);
    lines.push(
      `${PREFIX}        Run 'kuzo credentials migrate' to move them to the encrypted store.`,
    );
  }

  return lines;
}
