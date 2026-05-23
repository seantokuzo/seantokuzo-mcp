/**
 * `kuzo plugins refresh-trust-root` — wipe Sigstore TUF + attestations caches.
 *
 * Spec §C §D.1: forces the next install to re-fetch Sigstore's TUF root and
 * re-resolve every attestation fresh. Useful when a TUF key rotation is
 * rumored or when troubleshooting a suspected stale-cache verification bug.
 *
 * Mutates shared state under ~/.kuzo/ → must acquire the plugins lock.
 * Attestations cache directory may not exist yet (Part C ships it, Part D+
 * starts populating it); missing dir is treated as a successful no-op.
 */

import { existsSync, rmSync } from "node:fs";

import boxen from "boxen";
import chalk from "chalk";

import { FileBackedAuditLogger } from "@kuzo-mcp/core/audit";
import { attestationsCacheDir, tufCacheDir } from "@kuzo-mcp/core/paths";

import { acquireLock, PluginsLockedError } from "./lock.js";

export function runRefreshTrustRoot(): void {
  const audit = new FileBackedAuditLogger();
  // Let PluginsLockedError bubble to the Commander action so
  // exitCodeForRefreshTrustRootError can map it. No async work happens in
  // here — keep the function synchronous to surface errors directly.
  const release = acquireLock("refresh-trust-root");
  try {
    const wipedTuf = wipeIfExists(tufCacheDir());
    const wipedAttestations = wipeIfExists(attestationsCacheDir());

    audit.log({
      plugin: "system",
      action: "plugin.trust_root_refreshed",
      outcome: "allowed",
      details: {
        tufCacheWiped: wipedTuf,
        attestationsCacheWiped: wipedAttestations,
      },
    });

    printSuccess(wipedTuf, wipedAttestations);
  } finally {
    release();
  }
}

function wipeIfExists(dir: string): boolean {
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

function printSuccess(wipedTuf: boolean, wipedAttestations: boolean): void {
  const tufLine = wipedTuf
    ? chalk.green("✓ Wiped Sigstore TUF cache")
    : chalk.gray("— TUF cache was already empty");
  const attLine = wipedAttestations
    ? chalk.green("✓ Wiped attestations cache")
    : chalk.gray("— attestations cache was already empty");

  console.log(
    "\n" +
      boxen(
        chalk.green.bold("Trust root refreshed") +
          "\n\n" +
          tufLine +
          "\n" +
          attLine +
          "\n\n" +
          chalk.gray(
            "Next install or verify will re-fetch the Sigstore TUF root.",
          ),
        { padding: 1, borderColor: "green" },
      ),
  );
}

export function exitCodeForRefreshTrustRootError(err: unknown): number {
  if (err instanceof PluginsLockedError) return 30;
  return 1;
}
