/**
 * `kuzo plugins install` — verify + stage + consent + commit.
 *
 * Implements the install algorithm from docs/2.5e-spec.md §C.1:
 *
 *   1. Resolve friendly-name → npm package name (BUILTIN_PLUGINS + config)
 *   2. Acquire ~/.kuzo/plugins/.lock
 *   3. verifyPackageProvenance() from @kuzo-mcp/core/provenance
 *      - skipped when --trust-unsigned (loud warning)
 *   4. If --dry-run: print plan and exit 0
 *   5. Show summary card + y/N confirmation (unless --yes)
 *   6. pacote.extract → .tmp/pkg/ (no install scripts) — staging.ts
 *   7. npm install --prefix=.tmp --ignore-scripts (transitive deps sibling to pkg/)
 *   8. Dynamic-import .tmp/pkg/dist/index.js → KuzoPluginV2 manifest
 *   9. Consent flow (delegate to ConsentStore)
 *  10. Write verification.json (with policySnapshot per spec §C.8)
 *  11. Atomic commit: rename .tmp/ → <version>/, flip current symlink, update index.json
 *  12. Prune retained versions beyond last 3
 *
 * Exit codes: 10-19 from @kuzo-mcp/core/provenance, 30 for lock contention,
 * 40+ reserved here for install-domain errors, 42-44 for staging errors.
 */

import {
  existsSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";

import boxen from "boxen";
import chalk from "chalk";
import { createSpinner } from "nanospinner";
import pacote from "pacote";

import { AuditLogger } from "@kuzo-mcp/core/audit";
import { ConsentStore } from "@kuzo-mcp/core/consent";
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
  pluginDir,
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
  MAX_RETAINED_VERSIONS,
  readIndex,
  upsertEntry,
  writeIndex,
  type PluginIndexEntry,
  type PluginSource,
  type PluginsIndex,
} from "./state.js";
import {
  confirm,
  printCapabilitySummary,
  printSummaryCard,
} from "./summary-card.js";
import { writeVerificationFile } from "./verification-cache.js";

export interface InstallOptions {
  version?: string;
  registry?: string;
  trustUnsigned?: boolean;
  allowThirdParty?: boolean;
  allowBuilder?: string[];
  allowRegistry?: string;
  dryRun?: boolean;
  yes?: boolean;
}

const NPM_REGISTRY = "https://registry.npmjs.org/";

/** Same map the core resolver uses — duplicated here so CLI can avoid importing from core internals. */
const BUILTIN_PLUGINS: Readonly<Record<string, string>> = Object.freeze({
  "git-context": "@kuzo-mcp/plugin-git-context",
  github: "@kuzo-mcp/plugin-github",
  jira: "@kuzo-mcp/plugin-jira",
});

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function runInstall(
  nameArg: string,
  options: InstallOptions,
): Promise<void> {
  const audit = new AuditLogger();

  // --- Step 1: Resolve name@version -------------------------------------------
  const { friendlyName, pkg, versionSpec } = parseSpec(nameArg, options);

  // --- Registry gate (spec §C.9) ---------------------------------------------
  const registry = resolveRegistry(options);

  // --- Trust-unsigned loud warning -------------------------------------------
  if (options.trustUnsigned) {
    console.log(
      boxen(
        chalk.red.bold("⚠️  --trust-unsigned\n") +
          chalk.red(
            "Provenance verification is disabled for this install.\n" +
              "Any tarball published to this version will be accepted,\n" +
              "including tampered or unsigned packages. This is a\n" +
              "supply-chain risk.",
          ),
        { padding: 1, borderColor: "red", borderStyle: "double" },
      ),
    );
  }

  // --- Step 2: Dry-run doesn't touch disk → skip lock ------------------------
  // PluginsLockedError bubbles to the Commander action where exitCodeForError
  // maps it. Keep this module free of process.exit so callers stay testable.
  const release = options.dryRun ? () => {} : acquireLock("install");

  try {
    // --- Step 3: Verify provenance ------------------------------------------
    const policy = buildPolicy(options);
    const verification = await runVerification(
      friendlyName,
      pkg,
      versionSpec,
      registry,
      policy,
      options,
      audit,
    );

    // Resolved version (verified OR the pacote manifest we did ourselves in trust-unsigned mode)
    const resolvedVersion = verification.package.version;

    // --- Step 4: Dry-run exit path -----------------------------------------
    if (options.dryRun) {
      printSummaryCard(friendlyName, pkg, verification, {
        title: "kuzo plugins install",
        trustUnsigned: options.trustUnsigned,
      });
      console.log(chalk.cyan("\nDry run complete — no changes written."));
      return;
    }

    // --- Step 5: Confirmation prompt ---------------------------------------
    printSummaryCard(friendlyName, pkg, verification, {
      title: "kuzo plugins install",
      trustUnsigned: options.trustUnsigned,
    });
    if (!options.yes) {
      const confirmed = await confirm(`Install ${friendlyName}@${resolvedVersion}?`);
      if (!confirmed) {
        console.log(chalk.gray("Aborted by user."));
        return;
      }
    }

    // --- Step 6-7: Stage tarball + deps ------------------------------------
    // Pin to the verified version + integrity so we install the exact bytes
    // we verified, not whatever `latest`/range might resolve to by the time
    // pacote re-resolves (spec §C.9 + Copilot round 1).
    await stageTarball(
      friendlyName,
      pkg,
      resolvedVersion,
      registry,
      verification.package.integrity,
    );

    // --- Step 8: Parse manifest via dynamic import -------------------------
    const manifest = await loadStagedManifest(friendlyName);
    if (!isV2Plugin(manifest)) {
      cleanupStaging(friendlyName);
      throw new InstallError(
        "E_LEGACY_MANIFEST",
        `${pkg}@${resolvedVersion} uses the V1 permission model; V2 is required.`,
      );
    }
    if (manifest.name !== friendlyName) {
      cleanupStaging(friendlyName);
      throw new InstallError(
        "E_NAME_MISMATCH",
        `Plugin declares name="${manifest.name}" but was installed as "${friendlyName}".`,
      );
    }
    if (manifest.version !== resolvedVersion) {
      cleanupStaging(friendlyName);
      throw new InstallError(
        "E_VERSION_MISMATCH",
        `Plugin manifest declares version=${manifest.version}; npm says ${resolvedVersion}.`,
      );
    }

    // --- Step 9: Consent ----------------------------------------------------
    const consentStore = new ConsentStore();
    const consented = await runConsentFlow(manifest, consentStore, options);
    if (!consented) {
      cleanupStaging(friendlyName);
      audit.log({
        plugin: friendlyName,
        action: "plugin.installed",
        outcome: "denied",
        details: { version: resolvedVersion, reason: "consent denied" },
      });
      console.log(chalk.gray(`\nInstall aborted — consent denied.`));
      return;
    }

    // --- Step 10-11: Write evidence then atomic commit --------------------
    // verification.json is written into the staging dir BEFORE rename so it
    // moves with the package. The policy snapshot is what verify uses to
    // detect "policy changed → re-verify on next read" per spec §C.8.
    writeVerificationFile(stagingDir(friendlyName), verification, policy);

    const commitResult = commitAtomic(
      friendlyName,
      pkg,
      resolvedVersion,
      verification,
    );

    audit.log({
      plugin: friendlyName,
      action: "plugin.installed",
      outcome: "allowed",
      details: {
        version: resolvedVersion,
        packageName: pkg,
        source: commitResult.entry.source,
        trustUnsigned: options.trustUnsigned === true,
      },
    });

    printSuccess(friendlyName, resolvedVersion, commitResult);
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

function parseSpec(
  nameArg: string,
  options: InstallOptions,
): { friendlyName: string; pkg: string; versionSpec: string } {
  // Accept either "github", "github@1.2.0", or a raw npm package.
  const atIdx = nameArg.indexOf("@", nameArg.startsWith("@") ? 1 : 0);
  const rawName = atIdx >= 0 ? nameArg.slice(0, atIdx) : nameArg;
  const inlineVersion = atIdx >= 0 ? nameArg.slice(atIdx + 1) : undefined;

  const versionSpec = options.version ?? inlineVersion ?? "latest";

  // Built-in friendly name → scoped pkg. Otherwise rawName IS the pkg and the
  // friendly name is derived from the last path segment.
  if (BUILTIN_PLUGINS[rawName]) {
    return {
      friendlyName: rawName,
      pkg: BUILTIN_PLUGINS[rawName]!,
      versionSpec,
    };
  }

  // Third-party: rawName must be an npm package ("@scope/name" or "name").
  if (!rawName.match(/^(@[^/]+\/)?[^/]+$/)) {
    throw new InstallError(
      "E_INVALID_SPEC",
      `"${rawName}" is neither a built-in plugin nor a valid npm package name.`,
    );
  }
  // Friendly name = last path segment of package name.
  const friendly = rawName.includes("/")
    ? rawName.slice(rawName.indexOf("/") + 1)
    : rawName;
  return { friendlyName: friendly, pkg: rawName, versionSpec };
}

function resolveRegistry(options: InstallOptions): string {
  const requested = options.registry ?? options.allowRegistry;
  if (!requested) return NPM_REGISTRY;

  // Only npmjs.org produces SLSA provenance at scale in v1. Any other registry
  // needs --allow-registry. (Spec §C.9)
  const normalized = requested.endsWith("/") ? requested : `${requested}/`;
  if (normalized !== NPM_REGISTRY && !options.allowRegistry) {
    throw new InstallError(
      "E_UNSUPPORTED_REGISTRY",
      `Only ${NPM_REGISTRY} is supported by default. Pass --allow-registry <url> to override.`,
    );
  }
  return normalized;
}

async function runVerification(
  friendlyName: string,
  pkg: string,
  versionSpec: string,
  registry: string,
  policy: TrustPolicy,
  options: InstallOptions,
  audit: AuditLogger,
): Promise<VerifiedAttestation> {
  // --trust-unsigned: skip real verification, but still resolve the packument
  // so we know the integrity + version we're about to install. No audit
  // emission here — we log `plugin.installed` once, after commit succeeds.
  if (options.trustUnsigned) {
    const manifest = await pacote.manifest(`${pkg}@${versionSpec}`, {
      registry,
      fullMetadata: false,
    });
    return {
      package: {
        name: pkg,
        version: manifest.version,
        integrity: manifest._integrity ?? "",
      },
      firstParty: false,
      repo: "",
      builder: "",
      predicateTypes: [],
      attestationsCount: 0,
      verifiedAt: new Date().toISOString(),
    };
  }

  const spinner = createSpinner(`Verifying ${pkg}@${versionSpec}...`).start();

  const result = await verifyPackageProvenance(pkg, versionSpec, policy, {
    registry,
  });

  if (!result.ok) {
    spinner.error({ text: `Verification failed: ${result.message}` });
    audit.log({
      plugin: friendlyName,
      action: "plugin.installed",
      outcome: "denied",
      details: { code: result.code, reason: result.message, packageName: pkg },
    });
    throw new ProvenanceFailure(result.code, result.message);
  }

  spinner.success({
    text: `Verified ${pkg}@${result.value.package.version} (${result.value.firstParty ? "first-party" : "third-party"}, ${result.value.attestationsCount} attestations)`,
  });
  return result.value;
}

function buildPolicy(options: InstallOptions): TrustPolicy {
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

async function runConsentFlow(
  plugin: KuzoPluginV2,
  store: ConsentStore,
  options: InstallOptions,
): Promise<boolean> {
  // Fresh install: prompt unless --yes. `grantConsent()` is idempotent —
  // re-installs with the same manifest are a no-op here.
  printCapabilitySummary(plugin);

  if (!options.yes) {
    const confirmed = await confirm(
      `Grant ${plugin.name} the capabilities shown above?`,
    );
    if (!confirmed) return false;
  }

  const allCaps: Capability[] = [
    ...plugin.capabilities,
    ...(plugin.optionalCapabilities ?? []),
  ];
  store.grantConsent(plugin, allCaps);
  return true;
}

interface CommitResult {
  entry: PluginIndexEntry;
  prunedVersions: string[];
}

function commitAtomic(
  friendlyName: string,
  pkg: string,
  version: string,
  verification: VerifiedAttestation,
): CommitResult {
  const staging = stagingDir(friendlyName);
  const target = versionDir(friendlyName, version);

  // Idempotent re-install: clear the target version so rename can succeed.
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }

  // Atomic rename staging → versioned dir. Same filesystem → atomic on POSIX.
  // verification.json lives inside `staging` already (caller wrote it before
  // calling us), so it moves with the package.
  renameSync(staging, target);

  // Flip `current` symlink → <version>/. Create parent dir if first install.
  const symlinkPath = currentSymlink(friendlyName);
  if (existsSync(symlinkPath)) {
    unlinkSync(symlinkPath);
  }
  symlinkSync(version, symlinkPath, "dir");

  // Update index.json — includes retention pruning.
  const source: PluginSource = verification.firstParty
    ? "first-party"
    : "third-party";
  const now = new Date().toISOString();
  const { index, prunedVersions } = upsertEntry(readIndex(), friendlyName, {
    currentVersion: version,
    packageName: pkg,
    installedAt: now,
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

  return {
    entry: index.plugins[friendlyName]!,
    prunedVersions,
  };
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function printSuccess(
  friendlyName: string,
  version: string,
  commit: CommitResult,
): void {
  console.log(
    "\n" +
      boxen(
        chalk.green.bold(`✓ Installed ${friendlyName}@${version}`) +
          "\n" +
          chalk.gray(
            `Location: ${pluginDir(friendlyName)}/current\n` +
              `Source:   ${commit.entry.source}\n` +
              (commit.prunedVersions.length > 0
                ? `Pruned:   ${commit.prunedVersions.join(", ")} (retention: ${String(MAX_RETAINED_VERSIONS)})\n`
                : "") +
              `\nNext step: add "${friendlyName}": { enabled: true } to kuzo.config.ts,\n` +
              "then restart the MCP server.",
          ),
        { padding: 1, borderColor: "green" },
      ),
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type InstallErrorCode =
  | "E_INVALID_SPEC"
  | "E_UNSUPPORTED_REGISTRY"
  | "E_LEGACY_MANIFEST"
  | "E_NAME_MISMATCH"
  | "E_VERSION_MISMATCH";

/** Non-provenance, non-staging install failures. Exit codes 40-49 reserved. */
export class InstallError extends Error {
  readonly code: InstallErrorCode;
  readonly exitCode: number;
  constructor(code: InstallErrorCode, message: string) {
    super(message);
    this.name = "InstallError";
    this.code = code;
    this.exitCode = INSTALL_ERROR_EXIT_CODES[code];
  }
}

const INSTALL_ERROR_EXIT_CODES: Record<InstallErrorCode, number> = {
  E_INVALID_SPEC: 40,
  E_UNSUPPORTED_REGISTRY: 41,
  E_LEGACY_MANIFEST: 45,
  E_NAME_MISMATCH: 46,
  E_VERSION_MISMATCH: 46,
};

/** Re-thrown from verifyPackageProvenance. Carries the numeric exit code. */
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

/** Maps CLI-surface errors to process exit codes; used by the Commander action. */
export function exitCodeForError(err: unknown): number {
  if (err instanceof ProvenanceFailure) return err.exitCode;
  if (err instanceof InstallError) return err.exitCode;
  if (err instanceof StagingError) return STAGING_ERROR_EXIT_CODES[err.code];
  if (err instanceof PluginsLockedError) return 30;
  return 1;
}

/** Used by the callers of readIndex who need the full shape. */
export type { PluginsIndex };
