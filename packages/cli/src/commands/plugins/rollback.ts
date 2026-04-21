/**
 * `kuzo plugins rollback <name> [<version>]` — restore a retained version
 * (spec §D.4).
 *
 * Targeting:
 *   - With `<version>`: must be in the index's `retainedVersions` list AND the
 *     directory must still exist on disk. If the user manually `rm -rf`'d a
 *     retained version, fail with E_VERSION_DIR_MISSING.
 *   - Without `<version>`: target = `retainedVersions[1]` (the version before
 *     current). If retained < 2, fail with E_NO_RETAINED_TARGET (exit 20)
 *     and suggest `kuzo plugins install <pkg>@<version>` as the recovery path.
 *
 * Re-consent is mandatory — rollback is NOT implicitly less risky than upgrade.
 * The target version's capability surface may differ from what the user is
 * currently consenting to, so we run the same diff-and-prompt flow as update.
 *
 * Provenance is NOT re-verified for rollback. The target version was already
 * verified at original install time (its `verification.json` sits next to it).
 * Use `kuzo plugins verify <name>` after rollback if you want to re-confirm.
 *
 * Exit codes:
 *   - 0 on success
 *   - 20 (E_NO_RETAINED_TARGET) when n-1 isn't retained and no explicit version was given
 *   - 30 lock contention
 *   - 45-46 manifest mismatches
 *   - 48 (E_NOT_INSTALLED) when name doesn't match
 *   - 51 (E_VERSION_DIR_MISSING) when target version dir is gone
 *   - 52 (E_VERSION_NOT_RETAINED) when explicit version isn't in retained list
 */

import { existsSync, symlinkSync, unlinkSync } from "node:fs";

import boxen from "boxen";
import chalk from "chalk";

import { AuditLogger } from "@kuzo-mcp/core/audit";
import {
  ConsentStore,
  diffCapabilities,
  type ConsentRecord,
} from "@kuzo-mcp/core/consent";
import {
  isV2Plugin,
  type Capability,
  type KuzoPluginV2,
} from "@kuzo-mcp/types";

import { acquireLock, PluginsLockedError } from "./lock.js";
import { currentSymlink, versionDir } from "./paths.js";
import { loadVersionedManifest, StagingError, STAGING_ERROR_EXIT_CODES } from "./staging.js";
import { readIndex, writeIndex, type PluginIndexEntry } from "./state.js";
import { confirm, printCapabilityDiff } from "./summary-card.js";
import { readVerificationCache } from "./verification-cache.js";

export interface RollbackOptions {
  yes?: boolean;
}

export async function runRollback(
  nameArg: string,
  versionArg: string | undefined,
  options: RollbackOptions,
): Promise<void> {
  const audit = new AuditLogger();
  const index = readIndex();

  const resolved = resolveInstalled(index.plugins, nameArg);
  if (!resolved) {
    throw new RollbackError(
      "E_NOT_INSTALLED",
      notInstalledMessage(nameArg, Object.keys(index.plugins)),
    );
  }
  const { friendlyName, entry } = resolved;

  const targetVersion = pickTarget(friendlyName, entry, versionArg);

  if (targetVersion === entry.currentVersion) {
    throw new RollbackError(
      "E_ALREADY_CURRENT",
      `${friendlyName}@${targetVersion} is already the current version. Nothing to roll back.`,
    );
  }

  // Verify the target dir exists — retention metadata can drift from disk
  // state if the user manually deleted a version.
  if (!existsSync(versionDir(friendlyName, targetVersion))) {
    throw new RollbackError(
      "E_VERSION_DIR_MISSING",
      `Retained version ${targetVersion} is in the index but its directory is missing on disk. ` +
        `Re-install with: kuzo plugins install ${entry.packageName}@${targetVersion}`,
    );
  }

  // Load the target's manifest now (BEFORE locking — read-only). If it's
  // unloadable, fail fast with a clean error rather than holding the lock
  // through I/O that might hang.
  let manifest: KuzoPluginV2;
  try {
    const loaded = await loadVersionedManifest(friendlyName, targetVersion);
    if (!isV2Plugin(loaded)) {
      throw new RollbackError(
        "E_LEGACY_MANIFEST",
        `${friendlyName}@${targetVersion} uses the V1 permission model; cannot roll back into a V2 install state.`,
      );
    }
    if (loaded.name !== friendlyName) {
      throw new RollbackError(
        "E_NAME_MISMATCH",
        `Target version's manifest declares name="${loaded.name}" but is installed as "${friendlyName}".`,
      );
    }
    if (loaded.version !== targetVersion) {
      throw new RollbackError(
        "E_VERSION_MISMATCH",
        `Target version's manifest declares version="${loaded.version}" but the directory is "${targetVersion}".`,
      );
    }
    manifest = loaded;
  } catch (err) {
    if (err instanceof RollbackError) throw err;
    if (err instanceof StagingError) throw err;
    throw new RollbackError(
      "E_MANIFEST_LOAD_FAILED",
      `Failed to load target manifest: ${(err as Error).message}`,
    );
  }

  // Re-consent against target's capabilities. Rollback is NOT implicitly safer
  // than upgrade — the older version may declare different capabilities.
  const consentStore = new ConsentStore();
  const consented = await runRollbackConsentFlow(
    manifest,
    targetVersion,
    entry.currentVersion,
    consentStore.getConsent(friendlyName),
    consentStore,
    options,
  );
  if (!consented) {
    audit.log({
      plugin: friendlyName,
      action: "plugin.rolled_back",
      outcome: "denied",
      details: {
        from: entry.currentVersion,
        to: targetVersion,
        reason: "consent denied",
      },
    });
    console.log(chalk.gray("\nRollback aborted — consent denied."));
    return;
  }

  // --- Lock + commit ----------------------------------------------------
  const release = acquireLock("rollback");
  try {
    flipSymlink(friendlyName, targetVersion);
    updateIndex(friendlyName, entry, targetVersion);
  } finally {
    release();
  }

  audit.log({
    plugin: friendlyName,
    action: "plugin.rolled_back",
    outcome: "allowed",
    details: {
      from: entry.currentVersion,
      to: targetVersion,
      packageName: entry.packageName,
    },
  });

  printSuccess(friendlyName, entry.currentVersion, targetVersion);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveInstalled(
  plugins: Record<string, PluginIndexEntry>,
  nameArg: string,
): { friendlyName: string; entry: PluginIndexEntry } | undefined {
  if (plugins[nameArg]) {
    return { friendlyName: nameArg, entry: plugins[nameArg] };
  }
  for (const [name, entry] of Object.entries(plugins)) {
    if (entry.packageName === nameArg) {
      return { friendlyName: name, entry };
    }
  }
  return undefined;
}

function notInstalledMessage(nameArg: string, installed: string[]): string {
  const head = `"${nameArg}" is not installed.`;
  if (installed.length === 0) {
    return `${head} No plugins are currently installed.`;
  }
  return `${head} Installed: ${installed.sort().join(", ")}`;
}

function pickTarget(
  friendlyName: string,
  entry: PluginIndexEntry,
  versionArg: string | undefined,
): string {
  if (versionArg) {
    if (!entry.retainedVersions.includes(versionArg)) {
      throw new RollbackError(
        "E_VERSION_NOT_RETAINED",
        `${friendlyName}@${versionArg} is not in the retained list. ` +
          `Available: ${entry.retainedVersions.join(", ")}. ` +
          `To install a non-retained version: kuzo plugins install ${entry.packageName}@${versionArg}`,
      );
    }
    return versionArg;
  }
  // Default: n-1 = retainedVersions[1] (currentVersion is at [0] by convention).
  // If retained.length < 2, there's no n-1 to roll back to.
  if (entry.retainedVersions.length < 2) {
    throw new RollbackError(
      "E_NO_RETAINED_TARGET",
      `No retained version to roll back to for ${friendlyName}. ` +
        `Install a specific older version explicitly: kuzo plugins install ${entry.packageName}@<version>`,
    );
  }
  return entry.retainedVersions[1]!;
}

async function runRollbackConsentFlow(
  plugin: KuzoPluginV2,
  targetVersion: string,
  currentVersion: string,
  existing: ConsentRecord | undefined,
  store: ConsentStore,
  options: RollbackOptions,
): Promise<boolean> {
  const allCaps: Capability[] = [
    ...plugin.capabilities,
    ...(plugin.optionalCapabilities ?? []),
  ];

  // No prior consent record → treat as fresh consent. Surface the full
  // capability set so the user knows what they're agreeing to.
  if (!existing) {
    printCapabilityDiff(plugin, allCaps, [], "Capabilities");
    if (!options.yes) {
      const confirmed = await confirm(
        `Roll back ${plugin.name} ${currentVersion} → ${targetVersion} and grant the capabilities above?`,
      );
      if (!confirmed) return false;
    }
    store.grantConsent(plugin, allCaps);
    return true;
  }

  const previouslyKnown = [...existing.granted, ...existing.denied];
  const diff = diffCapabilities(allCaps, previouslyKnown);

  if (diff.added.length === 0 && diff.removed.length === 0) {
    // Surface unchanged — but we still update the consent record's
    // pluginVersion field so isConsentStale doesn't re-fire on load.
    store.grantConsent(plugin, allCaps);
    if (!options.yes) {
      const confirmed = await confirm(
        `Roll back ${plugin.name} ${currentVersion} → ${targetVersion}? (capability surface unchanged)`,
      );
      if (!confirmed) return false;
    }
    return true;
  }

  printCapabilityDiff(
    plugin,
    diff.added,
    diff.removed,
    `Capability changes (rollback ${currentVersion} → ${targetVersion})`,
  );
  if (!options.yes) {
    const confirmed = await confirm(
      `Approve capabilities for ${plugin.name}@${targetVersion} and roll back?`,
    );
    if (!confirmed) return false;
  }
  store.grantConsent(plugin, allCaps);
  return true;
}

function flipSymlink(friendlyName: string, targetVersion: string): void {
  const symlinkPath = currentSymlink(friendlyName);
  if (existsSync(symlinkPath)) {
    unlinkSync(symlinkPath);
  }
  symlinkSync(targetVersion, symlinkPath, "dir");
}

/**
 * Update index.json to reflect the rollback.
 *
 * - currentVersion = target
 * - retainedVersions reordered to put target first (current → [1])
 * - installedAt unchanged (the original install date sticks)
 * - lastUpdatedAt = now (rollback IS an update event)
 * - integrity reflects target's recorded integrity, pulled from the existing
 *   retained-versions metadata via the per-version verification.json. We
 *   prefer that over recomputing because the verified value was the
 *   bytes-on-disk hash at original install time.
 */
function updateIndex(
  friendlyName: string,
  entry: PluginIndexEntry,
  targetVersion: string,
): void {
  const index = readIndex();
  const current = index.plugins[friendlyName];
  if (!current) {
    // Concurrent uninstall? Bail without writing.
    throw new RollbackError(
      "E_NOT_INSTALLED",
      `${friendlyName} disappeared from the index before rollback could commit.`,
    );
  }

  const targetIntegrity = readTargetIntegrity(friendlyName, targetVersion) ?? entry.integrity;

  // Reorder retained: target first, then everything else preserving order.
  // We DON'T re-prune because retained.length cannot grow — we're only
  // shuffling positions within a fixed-size list.
  const retained = [
    targetVersion,
    ...current.retainedVersions.filter((v) => v !== targetVersion),
  ];

  index.plugins[friendlyName] = {
    ...current,
    currentVersion: targetVersion,
    lastUpdatedAt: new Date().toISOString(),
    retainedVersions: retained,
    integrity: targetIntegrity,
  };
  writeIndex(index);
}

function readTargetIntegrity(
  friendlyName: string,
  version: string,
): string | undefined {
  return readVerificationCache(friendlyName, version)?.package.integrity;
}

function printSuccess(
  friendlyName: string,
  fromVersion: string,
  toVersion: string,
): void {
  console.log(
    "\n" +
      boxen(
        chalk.green.bold(`✓ Rolled back ${friendlyName}`) +
          "\n" +
          chalk.gray(
            `From: ${fromVersion}\n` +
              `To:   ${toVersion}\n` +
              "\nRestart the MCP server for the rollback to take effect.",
          ),
        { padding: 1, borderColor: "green" },
      ),
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type RollbackErrorCode =
  | "E_NOT_INSTALLED"
  | "E_NO_RETAINED_TARGET"
  | "E_VERSION_NOT_RETAINED"
  | "E_VERSION_DIR_MISSING"
  | "E_ALREADY_CURRENT"
  | "E_LEGACY_MANIFEST"
  | "E_NAME_MISMATCH"
  | "E_VERSION_MISMATCH"
  | "E_MANIFEST_LOAD_FAILED";

export class RollbackError extends Error {
  readonly code: RollbackErrorCode;
  readonly exitCode: number;
  constructor(code: RollbackErrorCode, message: string) {
    super(message);
    this.name = "RollbackError";
    this.code = code;
    this.exitCode = ROLLBACK_ERROR_EXIT_CODES[code];
  }
}

const ROLLBACK_ERROR_EXIT_CODES: Record<RollbackErrorCode, number> = {
  E_NOT_INSTALLED: 48,
  E_NO_RETAINED_TARGET: 20, // spec §D.4 — explicit
  E_VERSION_NOT_RETAINED: 52,
  E_VERSION_DIR_MISSING: 51,
  E_ALREADY_CURRENT: 53,
  E_LEGACY_MANIFEST: 45,
  E_NAME_MISMATCH: 46,
  E_VERSION_MISMATCH: 46,
  E_MANIFEST_LOAD_FAILED: 44,
};

export function exitCodeForRollbackError(err: unknown): number {
  if (err instanceof RollbackError) return err.exitCode;
  if (err instanceof StagingError) return STAGING_ERROR_EXIT_CODES[err.code];
  if (err instanceof PluginsLockedError) return 30;
  return 1;
}
