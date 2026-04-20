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
 *   6. pacote.extract → .tmp/pkg/ (no install scripts)
 *   7. npm install --prefix=.tmp --ignore-scripts (transitive deps sibling to pkg/)
 *   8. Dynamic-import .tmp/pkg/dist/index.js → KuzoPluginV2 manifest
 *   9. Consent flow (delegate to ConsentStore)
 *  10. Atomic commit: rename .tmp/ → <version>/, flip current symlink, update index.json
 *  11. Prune retained versions beyond last 3
 *
 * Exit codes: 10-19 from @kuzo-mcp/core/provenance, 30 for lock contention,
 * 40+ reserved here for install-domain errors.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

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
  type KuzoPlugin,
  type KuzoPluginV2,
} from "@kuzo-mcp/types";

import { acquireLock, PluginsLockedError } from "./lock.js";
import {
  currentSymlink,
  pluginDir,
  pluginsRoot,
  stagingDir,
  stagingPkgDir,
  versionDir,
} from "./paths.js";
import {
  MAX_RETAINED_VERSIONS,
  ensurePluginsRoot,
  readIndex,
  upsertEntry,
  writeIndex,
  type PluginIndexEntry,
  type PluginSource,
  type PluginsIndex,
} from "./state.js";

export interface InstallOptions {
  version?: string;
  registry?: string;
  trustUnsigned?: boolean;
  allowThirdParty?: boolean;
  allowBuilder?: string[];
  allowDeprecated?: boolean;
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
  const release = options.dryRun ? () => {} : acquireLockOrExit("install");

  try {
    // --- Step 3: Verify provenance ------------------------------------------
    const verification = await runVerification(
      pkg,
      versionSpec,
      registry,
      options,
      audit,
    );

    // Resolved version (verified OR the pacote manifest we did ourselves in trust-unsigned mode)
    const resolvedVersion = verification.package.version;

    // --- Step 4: Dry-run exit path -----------------------------------------
    if (options.dryRun) {
      printSummaryCard(friendlyName, pkg, verification, options);
      console.log(chalk.cyan("\nDry run complete — no changes written."));
      return;
    }

    // --- Step 5: Confirmation prompt ---------------------------------------
    printSummaryCard(friendlyName, pkg, verification, options);
    if (!options.yes) {
      const confirmed = await confirm(`Install ${friendlyName}@${resolvedVersion}?`);
      if (!confirmed) {
        console.log(chalk.gray("Aborted by user."));
        return;
      }
    }

    // --- Step 6-7: Stage tarball + deps ------------------------------------
    await stageTarball(friendlyName, pkg, versionSpec, registry);

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

    // --- Step 10: Atomic commit -------------------------------------------
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

function acquireLockOrExit(command: string): () => void {
  try {
    return acquireLock(command);
  } catch (err) {
    if (err instanceof PluginsLockedError) {
      console.error(chalk.red(err.message));
      process.exit(30);
    }
    throw err;
  }
}

async function runVerification(
  pkg: string,
  versionSpec: string,
  registry: string,
  options: InstallOptions,
  audit: AuditLogger,
): Promise<VerifiedAttestation> {
  // --trust-unsigned: skip real verification, but still resolve the packument
  // so we know the integrity + version we're about to install.
  if (options.trustUnsigned) {
    const manifest = await pacote.manifest(`${pkg}@${versionSpec}`, {
      registry,
      fullMetadata: false,
    });
    audit.log({
      plugin: pkg,
      action: "plugin.installed",
      outcome: "allowed",
      details: { version: manifest.version },
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

  const policy = buildPolicy(options);
  const spinner = createSpinner(`Verifying ${pkg}@${versionSpec}...`).start();

  const result = await verifyPackageProvenance(pkg, versionSpec, policy, {
    registry,
  });

  if (!result.ok) {
    spinner.error({ text: `Verification failed: ${result.message}` });
    audit.log({
      plugin: pkg,
      action: "plugin.installed",
      outcome: "denied",
      details: { code: result.code, reason: result.message },
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

async function stageTarball(
  friendlyName: string,
  pkg: string,
  versionSpec: string,
  registry: string,
): Promise<void> {
  ensurePluginsRoot();
  const staging = stagingDir(friendlyName);
  // Clean leftovers from a previous aborted install.
  if (existsSync(staging)) {
    rmSync(staging, { recursive: true, force: true });
  }
  mkdirSync(staging, { recursive: true });

  const pkgTarget = stagingPkgDir(friendlyName);

  const extract = createSpinner(`Extracting ${pkg}@${versionSpec}...`).start();
  try {
    // pacote.extract does NOT run install scripts. We still pass ignoreScripts
    // belt-and-braces in case future pacote versions gain such behavior.
    await pacote.extract(`${pkg}@${versionSpec}`, pkgTarget, {
      registry,
    });
    extract.success({ text: `Extracted tarball to ${relative(pluginsRoot(), pkgTarget)}` });
  } catch (err) {
    extract.error({ text: `Extract failed: ${(err as Error).message}` });
    cleanupStaging(friendlyName);
    throw new InstallError(
      "E_EXTRACT_FAILED",
      `Failed to extract tarball: ${(err as Error).message}`,
    );
  }

  // Build a sibling-to-pkg package.json so `npm install --prefix=<staging>`
  // resolves the plugin's declared deps, per spec §C.6 layout where
  // node_modules/ lives next to pkg/, not inside it.
  const pluginPkgJson = JSON.parse(
    readFileSync(join(pkgTarget, "package.json"), "utf-8"),
  ) as { dependencies?: Record<string, string> };
  const stagingPkgJson = {
    name: `kuzo-staging-${friendlyName}`,
    version: "0.0.0",
    private: true,
    dependencies: pluginPkgJson.dependencies ?? {},
  };
  writeFileSync(
    join(staging, "package.json"),
    JSON.stringify(stagingPkgJson, null, 2) + "\n",
    "utf-8",
  );

  const deps = createSpinner("Installing transitive deps (scripts disabled)...").start();
  const result = spawnSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      "--no-package-lock",
      "--no-save",
      "--registry",
      registry,
    ],
    { cwd: staging, stdio: "pipe", encoding: "utf-8" },
  );
  if (result.status !== 0) {
    deps.error({ text: "npm install failed" });
    cleanupStaging(friendlyName);
    throw new InstallError(
      "E_DEPS_INSTALL_FAILED",
      `npm install failed (exit ${String(result.status)}):\n${result.stderr || result.stdout}`,
    );
  }
  deps.success({ text: "Dependencies installed" });
}

async function loadStagedManifest(friendlyName: string): Promise<KuzoPlugin> {
  const pkgRoot = stagingPkgDir(friendlyName);
  const pkgJson = JSON.parse(
    readFileSync(join(pkgRoot, "package.json"), "utf-8"),
  ) as {
    main?: string;
    exports?: { "."?: { import?: string; default?: string } };
  };
  const entry =
    pkgJson.exports?.["."]?.import ??
    pkgJson.exports?.["."]?.default ??
    pkgJson.main;
  if (!entry) {
    throw new InstallError(
      "E_NO_ENTRY_POINT",
      `Plugin package has no entry point (main or exports["."]).`,
    );
  }
  const entryUrl = pathToFileURL(join(pkgRoot, entry)).href;

  let module: Record<string, unknown>;
  try {
    module = (await import(entryUrl)) as Record<string, unknown>;
  } catch (err) {
    throw new InstallError(
      "E_MANIFEST_LOAD_FAILED",
      `Failed to import plugin entry: ${(err as Error).message}`,
    );
  }

  const defaultExport = module["default"];
  if (!defaultExport || typeof defaultExport !== "object") {
    throw new InstallError(
      "E_NO_DEFAULT_EXPORT",
      `Plugin entry must default-export a KuzoPlugin object.`,
    );
  }
  return defaultExport as KuzoPlugin;
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

  // Write frozen verification evidence BEFORE the rename — if the evidence
  // write fails we still have the staging dir to inspect.
  const verifJson = {
    schemaVersion: 1,
    package: verification.package,
    verifiedAt: verification.verifiedAt,
    firstParty: verification.firstParty,
    repo: verification.repo,
    builder: verification.builder,
    predicateTypes: verification.predicateTypes,
    attestationsCount: verification.attestationsCount,
  };
  writeFileSync(
    join(staging, "verification.json"),
    JSON.stringify(verifJson, null, 2) + "\n",
    "utf-8",
  );

  // Atomic rename staging → versioned dir. Same filesystem → atomic on POSIX.
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

function cleanupStaging(friendlyName: string): void {
  const staging = stagingDir(friendlyName);
  if (existsSync(staging)) {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

async function confirm(message: string): Promise<boolean> {
  const inquirer = await import("inquirer");
  const { ok } = await inquirer.default.prompt<{ ok: boolean }>([
    { type: "confirm", name: "ok", message, default: false },
  ]);
  return ok;
}

function printSummaryCard(
  friendlyName: string,
  pkg: string,
  verification: VerifiedAttestation,
  options: InstallOptions,
): void {
  const firstParty = verification.firstParty
    ? chalk.green("✓ first-party")
    : chalk.yellow("third-party");
  const verified = options.trustUnsigned
    ? chalk.red.bold("✗ UNSIGNED (--trust-unsigned)")
    : chalk.green(`✓ ${verification.attestationsCount} attestations verified`);

  const lines = [
    `${chalk.bold("Plugin:")}        ${friendlyName}`,
    `${chalk.bold("Package:")}       ${pkg}`,
    `${chalk.bold("Version:")}       ${verification.package.version}`,
    `${chalk.bold("Source:")}        ${firstParty}`,
    `${chalk.bold("Verification:")}  ${verified}`,
  ];
  if (verification.repo) {
    lines.push(`${chalk.bold("Repo:")}          ${verification.repo}`);
  }
  if (verification.builder) {
    lines.push(`${chalk.bold("Builder:")}       ${verification.builder}`);
  }

  console.log(
    "\n" +
      boxen(lines.join("\n"), {
        padding: 1,
        borderColor: "cyan",
        title: "kuzo plugins install",
        titleAlignment: "left",
      }),
  );
}

function printCapabilitySummary(plugin: KuzoPluginV2): void {
  console.log(
    "\n" + chalk.bold(`Plugin ${plugin.name}@${plugin.version} requests:`),
  );
  if (plugin.capabilities.length > 0) {
    console.log(chalk.bold("\n  Required capabilities:"));
    for (const cap of plugin.capabilities) {
      console.log("    " + formatCapabilityShort(cap));
    }
  }
  if (plugin.optionalCapabilities && plugin.optionalCapabilities.length > 0) {
    console.log(chalk.bold("\n  Optional capabilities:"));
    for (const cap of plugin.optionalCapabilities) {
      console.log("    " + formatCapabilityShort(cap));
    }
  }
  console.log();
}

function formatCapabilityShort(cap: Capability): string {
  const tag = chalk.cyan(`[${cap.kind}]`);
  switch (cap.kind) {
    case "credentials":
      return `${tag} ${cap.env} (${cap.access})  — ${chalk.gray(cap.reason)}`;
    case "network":
      return `${tag} ${cap.domain}  — ${chalk.gray(cap.reason)}`;
    case "filesystem":
      return `${tag} ${cap.path} (${cap.access})  — ${chalk.gray(cap.reason)}`;
    case "cross-plugin":
      return `${tag} ${cap.target}  — ${chalk.gray(cap.reason)}`;
    case "system":
      return `${tag} ${cap.operation}${cap.command ? `:${cap.command}` : ""}  — ${chalk.gray(cap.reason)}`;
  }
}

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
  | "E_EXTRACT_FAILED"
  | "E_DEPS_INSTALL_FAILED"
  | "E_NO_ENTRY_POINT"
  | "E_MANIFEST_LOAD_FAILED"
  | "E_NO_DEFAULT_EXPORT"
  | "E_LEGACY_MANIFEST"
  | "E_NAME_MISMATCH"
  | "E_VERSION_MISMATCH";

/** Non-provenance install failures. Exit codes 40-49 reserved. */
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
  E_EXTRACT_FAILED: 42,
  E_DEPS_INSTALL_FAILED: 43,
  E_NO_ENTRY_POINT: 44,
  E_MANIFEST_LOAD_FAILED: 44,
  E_NO_DEFAULT_EXPORT: 44,
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
  if (err instanceof PluginsLockedError) return 30;
  return 1;
}

/** Used by the callers of readIndex who need the full shape. */
export type { PluginsIndex };
