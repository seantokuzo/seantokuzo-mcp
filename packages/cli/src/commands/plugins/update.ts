/**
 * `kuzo plugins update [<name>]` — update one or all plugins (spec §D.3).
 *
 * Algorithm per spec §D.3:
 *   1. read ~/.kuzo/plugins/index.json → list of installed plugins
 *   2. for each target plugin:
 *      a. pacote.manifest(pkg@latest) (or @<version> via --to) → fetch latest
 *      b. if latestVersion === currentVersion: skip
 *      c. run full Part C verification (§C.1 steps 4-7) on the new version
 *      d. stage tarball + load new manifest
 *      e. diff capabilities against currently-consented set
 *         - subset/equal → reuse consent
 *         - added/changed → surface diff table + require re-consent
 *         - declined → abort this plugin, continue with others
 *      f. write verification.json + commit (atomic rename + symlink + index)
 *      g. emit `plugin.updated` audit
 *   3. print summary: { updated: [...], skipped: [...], failed: [...] }
 *
 * Exit codes:
 *   - 0 on full success
 *   - Per-plugin failure code in single-plugin mode (e.g. 48 not-installed,
 *     10-19 provenance, 42-44 staging)
 *   - 49 (E_PARTIAL_FAILURE) in multi-plugin mode when at least one failed
 */

import boxen from "boxen";
import chalk from "chalk";
import { createSpinner } from "nanospinner";
import pacote from "pacote";

import {
  existsSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";

import { AuditLogger } from "@kuzo-mcp/core/audit";
import {
  ConsentStore,
  diffCapabilities,
  type ConsentRecord,
} from "@kuzo-mcp/core/consent";
import {
  DEFAULT_POLICY,
  exitCodeFor,
  type ProvenanceErrorCode,
  type TrustPolicy,
  type VerifiedAttestation,
  verifyPackageProvenance,
} from "@kuzo-mcp/core/provenance";
import {
  isV2Plugin,
  type Capability,
  type KuzoPluginV2,
} from "@kuzo-mcp/types";

import { acquireLock, PluginsLockedError } from "./lock.js";
import {
  currentSymlink,
  stagingDir,
  versionDir,
} from "./paths.js";
import {
  cleanupStaging,
  loadStagedManifest,
  stageTarball,
  StagingError,
  STAGING_ERROR_EXIT_CODES,
} from "./staging.js";
import {
  readIndex,
  upsertEntry,
  writeIndex,
  type PluginIndexEntry,
  type PluginSource,
} from "./state.js";
import {
  confirm,
  printCapabilityDiff,
  printSummaryCard,
} from "./summary-card.js";
import { writeVerificationFile } from "./verification-cache.js";

export interface UpdateOptions {
  to?: string;
  registry?: string;
  allowThirdParty?: boolean;
  allowBuilder?: string[];
  allowRegistry?: string;
  dryRun?: boolean;
  yes?: boolean;
}

const NPM_REGISTRY = "https://registry.npmjs.org/";

type UpdateResult =
  | { kind: "updated"; name: string; from: string; to: string }
  | { kind: "skipped"; name: string; version: string; reason: string }
  | { kind: "failed"; name: string; error: Error };

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function runUpdate(
  nameArg: string | undefined,
  options: UpdateOptions,
): Promise<void> {
  const audit = new AuditLogger();

  const policy = buildPolicy(options);
  const registry = resolveRegistry(options);

  // --- Acquire lock BEFORE reading index for non-dry-run ----------------
  // Reading the index outside the lock opens a TOCTOU window: a concurrent
  // uninstall can remove the plugin after we computed targets, and we'd
  // then "resurrect" its directory + index entry. Lock first, then read.
  // Dry-run performs no writes, so it can safely skip the lock.
  const release = options.dryRun ? () => {} : acquireLock("update");
  const results: UpdateResult[] = [];

  try {
    const index = readIndex();

    // --- Resolve targets --------------------------------------------------
    const targets = resolveTargets(index.plugins, nameArg);
    if (targets.length === 0) {
      if (nameArg) {
        throw new UpdateError(
          "E_NOT_INSTALLED",
          notInstalledMessage(nameArg, Object.keys(index.plugins)),
        );
      }
      console.log(
        chalk.gray(
          "No plugins installed. Try: kuzo plugins install <name>",
        ),
      );
      return;
    }

    for (const target of targets) {
      const result = await updateOne(
        target.friendlyName,
        target.entry,
        options,
        policy,
        registry,
        audit,
      );
      results.push(result);
    }
  } finally {
    release();
  }

  printSummary(results, options.dryRun === true);

  // Single-plugin: rethrow the original error so the right exit code surfaces.
  // Multi-plugin: aggregate into E_PARTIAL_FAILURE so the user sees the
  // summary AND a non-zero exit, without us picking a random "winner" code.
  const failures = results.filter(
    (r): r is Extract<UpdateResult, { kind: "failed" }> => r.kind === "failed",
  );
  if (failures.length === 0) return;
  if (results.length === 1) throw failures[0]!.error;
  throw new UpdateError(
    "E_PARTIAL_FAILURE",
    `${String(failures.length)} of ${String(results.length)} plugin(s) failed to update.`,
  );
}

// ---------------------------------------------------------------------------
// Per-plugin update
// ---------------------------------------------------------------------------

async function updateOne(
  friendlyName: string,
  entry: PluginIndexEntry,
  options: UpdateOptions,
  policy: TrustPolicy,
  registry: string,
  audit: AuditLogger,
): Promise<UpdateResult> {
  const versionSpec = options.to ?? "latest";

  // --- Manifest resolution + skip-if-same -------------------------------
  let resolvedVersion: string;
  let resolvedIntegrity: string;
  try {
    const resolveSpinner = createSpinner(
      `Resolving ${entry.packageName}@${versionSpec}...`,
    ).start();
    const resolved = await pacote.manifest(
      `${entry.packageName}@${versionSpec}`,
      { registry, fullMetadata: false },
    );
    resolvedVersion = resolved.version;
    resolvedIntegrity = resolved._integrity ?? "";
    resolveSpinner.success({
      text: `${entry.packageName} → ${resolvedVersion}${resolvedVersion === entry.currentVersion ? " (already current)" : ""}`,
    });
  } catch (err) {
    return {
      kind: "failed",
      name: friendlyName,
      error: new UpdateError(
        "E_RESOLVE_FAILED",
        `Failed to resolve ${entry.packageName}@${versionSpec}: ${(err as Error).message}`,
      ),
    };
  }

  if (resolvedVersion === entry.currentVersion) {
    return {
      kind: "skipped",
      name: friendlyName,
      version: resolvedVersion,
      reason: "already at latest",
    };
  }

  // --- Verify new version (Part C) --------------------------------------
  let verification: VerifiedAttestation;
  const verifySpinner = createSpinner(
    `Verifying ${entry.packageName}@${resolvedVersion}...`,
  ).start();
  try {
    const result = await verifyPackageProvenance(
      entry.packageName,
      resolvedVersion,
      policy,
      { registry },
    );
    if (!result.ok) {
      verifySpinner.error({ text: `Verification failed: ${result.message}` });
      return {
        kind: "failed",
        name: friendlyName,
        error: new ProvenanceFailure(result.code, result.message),
      };
    }
    verification = result.value;
    verifySpinner.success({
      text: `Verified ${entry.packageName}@${verification.package.version} (${verification.firstParty ? "first-party" : "third-party"}, ${verification.attestationsCount} attestations)`,
    });
  } catch (err) {
    verifySpinner.error({ text: `Verification error: ${(err as Error).message}` });
    return { kind: "failed", name: friendlyName, error: err as Error };
  }

  // --- Dry-run: print plan and bail ------------------------------------
  if (options.dryRun) {
    printSummaryCard(friendlyName, entry.packageName, verification, {
      title: `kuzo plugins update — ${entry.currentVersion} → ${resolvedVersion}`,
    });
    return {
      kind: "skipped",
      name: friendlyName,
      version: resolvedVersion,
      reason: "dry-run",
    };
  }

  // --- Stage + manifest validation -------------------------------------
  try {
    await stageTarball(
      friendlyName,
      entry.packageName,
      resolvedVersion,
      registry,
      verification.package.integrity ||
        // pacote.manifest's _integrity should always populate, but use the
        // earlier resolve as a fallback so we don't pass empty string and
        // skip pacote's integrity check entirely.
        resolvedIntegrity,
    );
  } catch (err) {
    return { kind: "failed", name: friendlyName, error: err as Error };
  }

  let manifest: KuzoPluginV2;
  try {
    const loaded = await loadStagedManifest(friendlyName);
    if (!isV2Plugin(loaded)) {
      cleanupStaging(friendlyName);
      return {
        kind: "failed",
        name: friendlyName,
        error: new UpdateError(
          "E_LEGACY_MANIFEST",
          `${entry.packageName}@${resolvedVersion} uses the V1 permission model; V2 is required.`,
        ),
      };
    }
    if (loaded.name !== friendlyName) {
      cleanupStaging(friendlyName);
      return {
        kind: "failed",
        name: friendlyName,
        error: new UpdateError(
          "E_NAME_MISMATCH",
          `Plugin declares name="${loaded.name}" but is installed as "${friendlyName}".`,
        ),
      };
    }
    if (loaded.version !== resolvedVersion) {
      cleanupStaging(friendlyName);
      return {
        kind: "failed",
        name: friendlyName,
        error: new UpdateError(
          "E_VERSION_MISMATCH",
          `Plugin manifest declares version=${loaded.version}; npm says ${resolvedVersion}.`,
        ),
      };
    }
    manifest = loaded;
  } catch (err) {
    cleanupStaging(friendlyName);
    return { kind: "failed", name: friendlyName, error: err as Error };
  }

  // --- Capability diff + re-consent ------------------------------------
  const consentStore = new ConsentStore();
  const existingConsent = consentStore.getConsent(friendlyName);
  const consented = await runUpdateConsentFlow(
    manifest,
    existingConsent,
    consentStore,
    options,
  );
  if (!consented) {
    cleanupStaging(friendlyName);
    audit.log({
      plugin: friendlyName,
      action: "plugin.updated",
      outcome: "denied",
      details: {
        from: entry.currentVersion,
        to: resolvedVersion,
        reason: "consent denied",
      },
    });
    return {
      kind: "skipped",
      name: friendlyName,
      version: resolvedVersion,
      reason: "consent denied",
    };
  }

  // --- Commit -----------------------------------------------------------
  writeVerificationFile(stagingDir(friendlyName), verification, policy);
  try {
    commitUpdate(friendlyName, entry.packageName, resolvedVersion, verification);
  } catch (err) {
    cleanupStaging(friendlyName);
    return { kind: "failed", name: friendlyName, error: err as Error };
  }

  audit.log({
    plugin: friendlyName,
    action: "plugin.updated",
    outcome: "allowed",
    details: {
      from: entry.currentVersion,
      to: resolvedVersion,
      packageName: entry.packageName,
    },
  });

  return {
    kind: "updated",
    name: friendlyName,
    from: entry.currentVersion,
    to: resolvedVersion,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Target {
  friendlyName: string;
  entry: PluginIndexEntry;
}

function resolveTargets(
  plugins: Record<string, PluginIndexEntry>,
  nameArg: string | undefined,
): Target[] {
  if (!nameArg) {
    return Object.entries(plugins)
      .map(([friendlyName, entry]) => ({ friendlyName, entry }))
      .sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));
  }
  if (plugins[nameArg]) {
    return [{ friendlyName: nameArg, entry: plugins[nameArg] }];
  }
  for (const [name, entry] of Object.entries(plugins)) {
    if (entry.packageName === nameArg) {
      return [{ friendlyName: name, entry }];
    }
  }
  return [];
}

function notInstalledMessage(nameArg: string, installed: string[]): string {
  const head = `"${nameArg}" is not installed.`;
  if (installed.length === 0) {
    return `${head} No plugins are currently installed.`;
  }
  return `${head} Installed: ${installed.sort().join(", ")}`;
}

function buildPolicy(options: UpdateOptions): TrustPolicy {
  return {
    allowedBuilders: [
      ...DEFAULT_POLICY.allowedBuilders,
      ...(options.allowBuilder ?? []),
    ],
    firstPartyOrgs: [...DEFAULT_POLICY.firstPartyOrgs],
    allowThirdParty:
      options.allowThirdParty ?? DEFAULT_POLICY.allowThirdParty,
  };
}

function resolveRegistry(options: UpdateOptions): string {
  // `--allow-registry` is strictly a gate, not a selector — pairing the gate
  // flag with no `--registry` should be a no-op rather than silently
  // switching the registry. (Fix matches verify + install.)
  const requested = options.registry;
  if (!requested) return NPM_REGISTRY;
  const normalized = requested.endsWith("/") ? requested : `${requested}/`;
  if (normalized !== NPM_REGISTRY && !options.allowRegistry) {
    throw new UpdateError(
      "E_UNSUPPORTED_REGISTRY",
      `Only ${NPM_REGISTRY} is supported by default. Pass --allow-registry <url> to override.`,
    );
  }
  return normalized;
}

async function runUpdateConsentFlow(
  plugin: KuzoPluginV2,
  existing: ConsentRecord | undefined,
  store: ConsentStore,
  options: UpdateOptions,
): Promise<boolean> {
  const allCaps: Capability[] = [
    ...plugin.capabilities,
    ...(plugin.optionalCapabilities ?? []),
  ];

  // No prior consent record (e.g. user wiped consent.json) → treat as fresh
  // install and prompt for the full set.
  if (!existing) {
    printCapabilityDiff(plugin, allCaps, [], "Capabilities");
    if (!options.yes) {
      const confirmed = await confirm(
        `Grant ${plugin.name}@${plugin.version} the capabilities shown above?`,
      );
      if (!confirmed) return false;
    }
    store.grantConsent(plugin, allCaps);
    return true;
  }

  const previouslyKnown = [...existing.granted, ...existing.denied];
  const diff = diffCapabilities(allCaps, previouslyKnown);

  if (diff.added.length === 0 && diff.removed.length === 0) {
    // Capability surface unchanged. Refresh the stored record so it tracks
    // the new pluginVersion (otherwise isConsentStale would re-fire on load).
    store.grantConsent(plugin, allCaps);
    console.log(
      chalk.gray(
        `  ↻ ${plugin.name}: capability surface unchanged, reusing consent`,
      ),
    );
    return true;
  }

  // Capabilities changed → surface diff and re-prompt.
  printCapabilityDiff(plugin, diff.added, diff.removed, "Capability changes");
  if (!options.yes) {
    const confirmed = await confirm(
      `Approve updated capabilities for ${plugin.name}@${plugin.version}?`,
    );
    if (!confirmed) return false;
  }
  store.grantConsent(plugin, allCaps);
  return true;
}

/**
 * Same shape as install's commitAtomic, except update preserves the previous
 * `installedAt` timestamp (handled inside upsertEntry — it keeps `existing.
 * installedAt` when the plugin is already known) and bumps `lastUpdatedAt`.
 */
function commitUpdate(
  friendlyName: string,
  pkg: string,
  version: string,
  verification: VerifiedAttestation,
): void {
  const staging = stagingDir(friendlyName);
  const target = versionDir(friendlyName, version);

  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  renameSync(staging, target);

  const symlinkPath = currentSymlink(friendlyName);
  if (existsSync(symlinkPath)) {
    unlinkSync(symlinkPath);
  }
  symlinkSync(version, symlinkPath, "dir");

  const source: PluginSource = verification.firstParty
    ? "first-party"
    : "third-party";
  const now = new Date().toISOString();
  const { index, prunedVersions } = upsertEntry(readIndex(), friendlyName, {
    currentVersion: version,
    packageName: pkg,
    installedAt: now, // upsertEntry keeps existing.installedAt if present
    lastUpdatedAt: now,
    source,
    integrity: verification.package.integrity,
  });
  writeIndex(index);

  for (const v of prunedVersions) {
    const pruneDir = versionDir(friendlyName, v);
    if (existsSync(pruneDir)) {
      rmSync(pruneDir, { recursive: true, force: true });
    }
  }
}

function printSummary(results: UpdateResult[], dryRun: boolean): void {
  const updated = results.filter((r) => r.kind === "updated");
  const skipped = results.filter((r) => r.kind === "skipped");
  const failed = results.filter((r) => r.kind === "failed");

  const lines: string[] = [chalk.bold("Update summary")];
  if (dryRun) lines.push(chalk.cyan("(dry-run — no changes written)"));
  lines.push("");

  if (updated.length > 0) {
    lines.push(chalk.green.bold("Updated:"));
    for (const r of updated) {
      if (r.kind !== "updated") continue;
      lines.push(`  ✓ ${r.name}: ${r.from} → ${r.to}`);
    }
  }
  if (skipped.length > 0) {
    lines.push(chalk.gray.bold("Skipped:"));
    for (const r of skipped) {
      if (r.kind !== "skipped") continue;
      lines.push(`  · ${r.name}@${r.version} (${r.reason})`);
    }
  }
  if (failed.length > 0) {
    lines.push(chalk.red.bold("Failed:"));
    for (const r of failed) {
      if (r.kind !== "failed") continue;
      lines.push(`  ✗ ${r.name}: ${r.error.message}`);
    }
  }

  if (updated.length === 0 && skipped.length === 0 && failed.length === 0) {
    lines.push(chalk.gray("(no plugins processed)"));
  }

  if (updated.length > 0 && !dryRun) {
    lines.push(
      "",
      chalk.gray("Restart the MCP server for updates to take effect."),
    );
  }

  console.log(
    "\n" +
      boxen(lines.join("\n"), {
        padding: 1,
        borderColor: failed.length > 0 ? "red" : "green",
      }),
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type UpdateErrorCode =
  | "E_NOT_INSTALLED"
  | "E_UNSUPPORTED_REGISTRY"
  | "E_RESOLVE_FAILED"
  | "E_LEGACY_MANIFEST"
  | "E_NAME_MISMATCH"
  | "E_VERSION_MISMATCH"
  | "E_PARTIAL_FAILURE";

export class UpdateError extends Error {
  readonly code: UpdateErrorCode;
  readonly exitCode: number;
  constructor(code: UpdateErrorCode, message: string) {
    super(message);
    this.name = "UpdateError";
    this.code = code;
    this.exitCode = UPDATE_ERROR_EXIT_CODES[code];
  }
}

const UPDATE_ERROR_EXIT_CODES: Record<UpdateErrorCode, number> = {
  E_NOT_INSTALLED: 48,
  E_UNSUPPORTED_REGISTRY: 41,
  E_RESOLVE_FAILED: 50,
  E_LEGACY_MANIFEST: 45,
  E_NAME_MISMATCH: 46,
  E_VERSION_MISMATCH: 46,
  E_PARTIAL_FAILURE: 49,
};

export class ProvenanceFailure extends Error {
  readonly code: ProvenanceErrorCode;
  readonly exitCode: number;
  constructor(code: ProvenanceErrorCode, message: string) {
    super(message);
    this.name = "ProvenanceFailure";
    this.code = code;
    this.exitCode = exitCodeFor(code);
  }
}

export function exitCodeForUpdateError(err: unknown): number {
  if (err instanceof ProvenanceFailure) return err.exitCode;
  if (err instanceof UpdateError) return err.exitCode;
  if (err instanceof StagingError) return STAGING_ERROR_EXIT_CODES[err.code];
  if (err instanceof PluginsLockedError) return 30;
  return 1;
}
