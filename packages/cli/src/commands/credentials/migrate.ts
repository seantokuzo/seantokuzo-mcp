/**
 * `kuzo credentials migrate` (spec §B.4) — the footgun command.
 *
 * One-shot import of credentials from `~/.claude/settings.json` env blocks and
 * project-local `.env` files into the encrypted store, then atomic redaction of
 * the source files. The ordering is deliberate and load-bearing:
 *
 *   discover → classify (new / already-migrated / conflict) → confirm →
 *   safety-check every source + snapshot the store → import + read-back-verify
 *   (rollback the store on failure, before any source is touched) →
 *   per-source rewrite (editor-collision check → atomic write → redaction-verify)
 *
 * Invariants (spec §B.4 "Failure-mode invariants"):
 *   - No `.bak` files; atomic tmp+rename only.
 *   - In-memory zeroing happens AFTER the success path (read-back needs the
 *     cleartext to compare against).
 *   - The store is rolled back ONLY when an import read-back fails — i.e. before
 *     any source file is rewritten, so there is no source-as-fallback yet. Once
 *     a source has been redacted, a later failure is a partial success (the
 *     credential is stored AND the other sources still hold it), never a
 *     rollback — "stored + duplicate" beats "redacted + missing".
 *   - Audit records the credential KEY + source, never the value.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";

import { type AuditLogger } from "@kuzo-mcp/core/audit";
import { KDF_KEYCHAIN, type KeyProvider } from "@kuzo-mcp/core/credentials";
import { credentialsFilePath } from "@kuzo-mcp/core/paths";
import chalk from "chalk";

import { acquireKuzoLock, type LockHandle } from "../../lock.js";
import { CredentialsCliError } from "./errors.js";
import {
  discoverSources,
  type DiscoverOptions,
  type MigrateSource,
  type MigrateSourceKind,
} from "./migrate-discovery.js";
import {
  assertSourceUnchanged,
  atomicRewriteSource,
  safeReadSource,
} from "./migrate-fs.js";
import {
  redactDotenv,
  redactSettingsJson,
  verifyDotenvRedaction,
  verifySettingsRedaction,
  type RedactionLeak,
} from "./migrate-redact.js";
import { openStore, translateStoreError, type StoreContext } from "./store-access.js";
import { allKnownEnvNames } from "./targets.js";

export interface CredentialsMigrateOptions {
  source: "claude" | "env-file" | "both";
  dryRun: boolean;
  forceSource: boolean;
  yes: boolean;
}

/** Seams overridden by tests; production defaults wire the real store + lock. */
export interface MigrateDeps {
  discover: (opts: DiscoverOptions) => MigrateSource[];
  openStore: () => StoreContext;
  acquireLock: () => Promise<LockHandle>;
  knownEnvNames: () => Set<string>;
  credentialsFile: string;
  generationFile: string;
  home?: string;
  cwd?: string;
  confirm: (message: string) => Promise<boolean>;
  /** Loud per-name confirmation for `--force-source` (must type "yes"). */
  forceConfirm: (name: string, sources: string) => Promise<boolean>;
  log: (line: string) => void;
}

export function defaultMigrateDeps(): MigrateDeps {
  const credentialsFile = credentialsFilePath();
  return {
    discover: discoverSources,
    openStore,
    acquireLock: () => acquireKuzoLock("migrate"),
    knownEnvNames: allKnownEnvNames,
    credentialsFile,
    generationFile: `${credentialsFile}.generation`,
    confirm: defaultConfirm,
    forceConfirm: defaultForceConfirm,
    log: (line) => console.log(line),
  };
}

const AUDIT_SOURCE: Record<MigrateSourceKind, "claude-settings" | "env-file"> = {
  claude: "claude-settings",
  "env-file": "env-file",
};

type PlanAction = "import" | "rewrite-only" | "force-import";

interface NamePlan {
  name: string;
  value: string;
  sourceKind: MigrateSourceKind;
  action: PlanAction;
}

interface Conflict {
  name: string;
  message: string;
}

/** Encrypted-store state captured before any write, for rollback (§B.4 1.f). */
type StoreSnapshot =
  | { kind: "absent"; generationBefore: bigint | undefined }
  | { kind: "exists"; bytes: Buffer; generationBefore: bigint | undefined };

export async function runMigrate(
  options: CredentialsMigrateOptions,
  deps: MigrateDeps = defaultMigrateDeps(),
): Promise<void> {
  if (options.forceSource && options.yes) {
    throw new CredentialsCliError(
      "E_INVALID_FLAG_COMBO",
      "--force-source cannot be combined with --yes: overwriting a stored credential always requires an explicit, un-skippable confirmation.",
    );
  }

  const known = deps.knownEnvNames();
  const sources = deps.discover({
    source: options.source,
    knownEnvNames: known,
    home: deps.home,
    cwd: deps.cwd,
  });

  if (sources.length === 0) {
    deps.log(chalk.gray("Nothing to migrate — no known credentials found in any source."));
    return;
  }

  if (options.dryRun) {
    printDryRun(sources, deps.log);
    return;
  }

  const lock = await deps.acquireLock();
  let storeContext: StoreContext | undefined;
  let storeSnapshot: StoreSnapshot | undefined;
  try {
    storeContext = deps.openStore();
    const { store, keyProvider, audit } = storeContext;

    // ── Classify every candidate against the store (one decrypt) ─────────────
    const { plans, conflicts } = classify(sources, store, options.forceSource);
    if (conflicts.length > 0) {
      for (const c of conflicts) deps.log(chalk.red(`✗ ${c.message}`));
      throw new CredentialsCliError(
        "E_CONFLICT",
        `${conflicts.length} credential${conflicts.length === 1 ? "" : "s"} conflict with the stored value(s). ` +
          `Resolve manually via \`kuzo credentials set <NAME>\`, or re-run with --force-source to overwrite.`,
      );
    }

    printPlan(plans, sources, deps.log);

    // ── Confirmations ────────────────────────────────────────────────────────
    if (!options.yes && !(await deps.confirm("Proceed?"))) {
      deps.log(chalk.gray("Aborted — nothing changed."));
      return;
    }
    for (const plan of plans) {
      if (plan.action !== "force-import") continue;
      const ok = await deps.forceConfirm(plan.name, sourcesContaining(plan.name, sources));
      if (!ok) {
        throw new CredentialsCliError(
          "E_CONFLICT",
          `Overwrite of ${plan.name} declined; migration aborted with nothing changed.`,
        );
      }
    }

    // ── Safety checks: snapshot every source (refuses symlinks) BEFORE imports ─
    const snapshots = new Map<string, Buffer>();
    for (const source of sources) {
      snapshots.set(source.path, safeReadSource(source.path));
    }
    storeSnapshot = snapshotStore(deps.credentialsFile, deps.generationFile, keyProvider);

    // ── Import + read-back-verify (rolls back the store on failure) ───────────
    importCredentials(plans, store, keyProvider, audit, () => {
      rollbackStore(storeSnapshot!, deps.credentialsFile, deps.generationFile, keyProvider);
    });

    // ── Per-source redaction (collected partial failures) ─────────────────────
    const failures = rewriteSources(sources, snapshots, audit);

    const firstFailure = failures[0];
    if (firstFailure !== undefined) {
      printPartialSuccess(plans, sources, failures, deps.log);
      throw new CredentialsCliError(
        firstFailure.code,
        `Migration partially succeeded: ${failures.length} source file(s) could not be redacted. ` +
          `Your credentials are stored; the listed source(s) still contain them as a fallback.`,
      );
    }

    deps.log(
      chalk.green(`✓ Migrated ${countImported(plans)} credential(s) and redacted ${sources.length} source file(s).`),
    );
  } finally {
    if (storeSnapshot?.kind === "exists") storeSnapshot.bytes.fill(0);
    storeContext?.store.close();
    await lock.release();
  }
}

// ─── classification ─────────────────────────────────────────────────────────

function classify(
  sources: MigrateSource[],
  store: StoreContext["store"],
  forceSource: boolean,
): { plans: NamePlan[]; conflicts: Conflict[] } {
  // name → occurrences across sources
  const occurrences = new Map<string, Array<{ value: string; kind: MigrateSourceKind; path: string }>>();
  for (const source of sources) {
    for (const [name, value] of source.entries) {
      const list = occurrences.get(name) ?? [];
      list.push({ value, kind: source.kind, path: source.path });
      occurrences.set(name, list);
    }
  }

  const plans: NamePlan[] = [];
  const conflicts: Conflict[] = [];
  for (const [name, occs] of occurrences) {
    const distinctValues = new Set(occs.map((o) => o.value));
    if (distinctValues.size > 1) {
      // The same credential carries different values in different sources;
      // even --force-source can't disambiguate which one is authoritative.
      conflicts.push({
        name,
        message: `${name} has different values in ${occs.map((o) => o.path).join(" and ")}; reconcile them manually, then re-run.`,
      });
      continue;
    }
    const first = occs[0];
    if (first === undefined) continue;
    const value = first.value;
    let stored: string | undefined;
    try {
      stored = store.get(name);
    } catch (err) {
      translateStoreError(err);
    }
    if (stored === undefined) {
      plans.push({ name, value, sourceKind: first.kind, action: "import" });
    } else if (stored === value) {
      plans.push({ name, value, sourceKind: first.kind, action: "rewrite-only" });
    } else if (forceSource) {
      plans.push({ name, value, sourceKind: first.kind, action: "force-import" });
    } else {
      conflicts.push({
        name,
        message: `${name} is stored with a different value than the one in ${occs.map((o) => o.path).join(", ")}. Resolve via \`kuzo credentials set ${name}\` or re-run with --force-source.`,
      });
    }
  }
  return { plans, conflicts };
}

// ─── import + read-back ───────────────────────────────────────────────────────

function importCredentials(
  plans: NamePlan[],
  store: StoreContext["store"],
  keyProvider: KeyProvider,
  audit: AuditLogger,
  rollback: () => void,
): void {
  for (const plan of plans) {
    if (plan.action === "rewrite-only") continue;
    try {
      store.set(plan.name, plan.value);
    } catch (err) {
      translateStoreError(err);
    }

    let readBack: string | undefined;
    try {
      readBack = store.get(plan.name);
    } catch (err) {
      translateStoreError(err);
    }
    if (readBack !== plan.value) {
      audit.log({
        plugin: "kuzo",
        action: "credential.migration_partial",
        outcome: "denied",
        details: { credentialKey: plan.name, reason: "read_back_mismatch", rollback_attempted: true },
      });
      rollback(); // throws E_ROLLBACK_FAIL if the rollback itself fails
      throw new CredentialsCliError(
        "E_READBACK_FAIL",
        `Read-back verification failed for ${plan.name}: the value decrypted from the store does not match what was written. ` +
          `This indicates an encryption round-trip bug — the store was rolled back; please file an issue with the audit log.`,
      );
    }

    const generation = keyProvider.getGeneration?.()?.toString();
    if (plan.action === "force-import") {
      audit.log({
        plugin: "kuzo",
        action: "credential.set",
        outcome: "allowed",
        details: { credentialKey: plan.name, source: AUDIT_SOURCE[plan.sourceKind], reason: "migrate --force-source", generation },
      });
    } else {
      audit.log({
        plugin: "kuzo",
        action: "credential.migrated",
        outcome: "allowed",
        details: { credentialKey: plan.name, source: AUDIT_SOURCE[plan.sourceKind], generation },
      });
    }
  }
}

// ─── per-source rewrite ───────────────────────────────────────────────────────

interface RewriteFailure {
  path: string;
  code: CredentialsCliError["code"];
}

function rewriteSources(
  sources: MigrateSource[],
  snapshots: Map<string, Buffer>,
  audit: AuditLogger,
): RewriteFailure[] {
  const failures: RewriteFailure[] = [];
  for (const source of sources) {
    const dropKeys = new Set(source.entries.keys());
    const snapshot = snapshots.get(source.path);
    if (snapshot === undefined) continue;
    try {
      const content = snapshot.toString("utf-8");
      const rewritten =
        source.kind === "claude"
          ? redactSettingsJson(content, dropKeys)
          : redactDotenv(content, dropKeys);

      // 3.b editor-collision: the source must be byte-identical to the snapshot.
      assertSourceUnchanged(source.path, snapshot);
      // 3.c atomic replace.
      atomicRewriteSource(source.path, rewritten);
      // 3.d post-rewrite redaction-verify against the on-disk bytes.
      const onDisk = safeReadSource(source.path).toString("utf-8");
      const leaks: RedactionLeak[] =
        source.kind === "claude"
          ? verifySettingsRedaction(onDisk, source.entries)
          : verifyDotenvRedaction(onDisk, source.entries);
      if (leaks.length > 0) {
        throw new CredentialsCliError(
          "E_REDACTION_VERIFY_FAIL",
          `Redaction completed but the parser still finds ${leaks.map((l) => l.name).join(", ")} in ${source.path} — ` +
            `possible parser drift. The credential is stored; the source file may still contain it. Inspect ${source.path} and re-run.`,
        );
      }
    } catch (err) {
      const code = err instanceof CredentialsCliError ? err.code : "E_REDACTION_VERIFY_FAIL";
      failures.push({ path: source.path, code });
      audit.log({
        plugin: "kuzo",
        action: "credential.migration_partial",
        outcome: "denied",
        details: { source: source.path, reason: code },
      });
    }
  }
  return failures;
}

// ─── store snapshot + rollback (§B.4 1.f / 2.c) ───────────────────────────────

function snapshotStore(
  credentialsFile: string,
  generationFile: string,
  keyProvider: KeyProvider,
): StoreSnapshot {
  const generationBefore = keyProvider.getGeneration?.() ?? readGenerationFile(generationFile);
  if (existsSync(credentialsFile)) {
    return { kind: "exists", bytes: readFileSync(credentialsFile), generationBefore };
  }
  return { kind: "absent", generationBefore };
}

/**
 * Restore the store to its pre-migrate state. Only invoked on a read-back
 * failure (before any source is redacted). A failure here is itself surfaced as
 * E_ROLLBACK_FAIL (62).
 *
 * NOTE: the spec sketch wrote `bumpGeneration(generationBefore ?? 0)` for the
 * absent case, but `bumpGeneration` rejects `< 1` and a generation of 0 is
 * meaningless. When the store was absent AND there was no prior generation
 * (true-FRESH — our own `set()` created the key), the faithful restore is to
 * delete the freshly-created master key, returning to true-FRESH. When a prior
 * generation existed (FRESH-with-key), we re-pin it.
 */
function rollbackStore(
  snapshot: StoreSnapshot,
  credentialsFile: string,
  generationFile: string,
  keyProvider: KeyProvider,
): void {
  try {
    if (snapshot.kind === "absent") {
      if (existsSync(credentialsFile)) unlinkSync(credentialsFile);
      revertGeneration(snapshot.generationBefore, generationFile, keyProvider, /* absent */ true);
    } else {
      restoreBytesAtomic(credentialsFile, snapshot.bytes);
      revertGeneration(snapshot.generationBefore, generationFile, keyProvider, /* absent */ false);
    }
  } catch (err) {
    throw new CredentialsCliError(
      "E_ROLLBACK_FAIL",
      `Rollback of the encrypted store failed after a read-back error: ${(err as Error).message}. ` +
        `Run \`kuzo credentials list\` and inspect the audit log; you may need \`kuzo credentials wipe --confirm\`.`,
    );
  }
}

function revertGeneration(
  generationBefore: bigint | undefined,
  generationFile: string,
  keyProvider: KeyProvider,
  absent: boolean,
): void {
  if (keyProvider.kdfId === KDF_KEYCHAIN) {
    if (generationBefore !== undefined) {
      keyProvider.bumpGeneration?.(generationBefore);
    } else if (absent) {
      keyProvider.deleteMasterKey?.(); // true-FRESH: drop the key our set() created
    }
    return;
  }
  // passphrase / scrypt mode: the counter lives in the generation file.
  if (generationBefore !== undefined) {
    writeGenerationFile(generationFile, generationBefore);
  } else if (absent && existsSync(generationFile)) {
    unlinkSync(generationFile);
  }
}

function readGenerationFile(path: string): bigint | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf-8").trim();
  return /^\d+$/.test(raw) ? BigInt(raw) : undefined;
}

function writeGenerationFile(path: string, generation: bigint): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${generation.toString()}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function restoreBytesAtomic(path: string, bytes: Buffer): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

// ─── output ───────────────────────────────────────────────────────────────

function printDryRun(sources: MigrateSource[], log: (line: string) => void): void {
  log(chalk.bold("This migration would (dry-run — maximum candidate set, no equality check):"));
  for (const source of sources) {
    log(chalk.cyan(`  ${source.path}`));
    for (const name of source.entries.keys()) {
      log(`    ${name}  ${chalk.gray("(would import + redact)")}`);
    }
  }
  log(chalk.gray("\nAn actual run skips values already stored identically. Re-run without --dry-run to apply."));
}

function printPlan(plans: NamePlan[], sources: MigrateSource[], log: (line: string) => void): void {
  const imports = plans.filter((p) => p.action === "import");
  const forces = plans.filter((p) => p.action === "force-import");
  log(chalk.bold("This migration will:"));
  if (imports.length > 0) {
    log(`  IMPORT ${imports.length} credential(s) into the keychain-encrypted store:`);
    for (const p of imports) log(`    ${p.name}`);
  }
  if (forces.length > 0) {
    log(chalk.yellow(`  OVERWRITE ${forces.length} stored credential(s) with the source value (--force-source):`));
    for (const p of forces) log(`    ${p.name}`);
  }
  log(`  REWRITE ${sources.length} source file(s) (the keys above are removed from each):`);
  for (const source of sources) log(`    ${source.path}`);
}

function printPartialSuccess(
  plans: NamePlan[],
  sources: MigrateSource[],
  failures: RewriteFailure[],
  log: (line: string) => void,
): void {
  const failedPaths = new Set(failures.map((f) => f.path));
  const redacted = sources.filter((s) => !failedPaths.has(s.path)).map((s) => s.path);
  log(chalk.yellow("\nMigration partially succeeded."));
  log(chalk.green(`  ✓ Imported into store: ${plans.map((p) => p.name).join(", ") || "(none)"}`));
  if (redacted.length > 0) log(chalk.green(`  ✓ Redacted from: ${redacted.join(", ")}`));
  for (const f of failures) log(chalk.red(`  ✗ Could NOT redact: ${f.path} (${f.code})`));
  log(
    chalk.gray(
      "\nTo finish, open each listed file and delete the credential keys from the kuzo MCP `env` block " +
        "(or the matching `.env` lines), then re-run `kuzo credentials migrate` (re-run is safe — already-stored values are skipped).",
    ),
  );
  log(chalk.gray("Your credentials are stored securely; the listed source(s) still contain them as a fallback until you finish."));
}

// ─── helpers ────────────────────────────────────────────────────────────────

function countImported(plans: NamePlan[]): number {
  return plans.filter((p) => p.action === "import" || p.action === "force-import").length;
}

function sourcesContaining(name: string, sources: MigrateSource[]): string {
  return sources
    .filter((s) => s.entries.has(name))
    .map((s) => s.path)
    .join(", ");
}

async function defaultConfirm(message: string): Promise<boolean> {
  const inquirer = await import("inquirer");
  const { ok } = await inquirer.default.prompt<{ ok: boolean }>([
    { type: "confirm", name: "ok", message, default: false },
  ]);
  return ok;
}

async function defaultForceConfirm(name: string, sources: string): Promise<boolean> {
  const inquirer = await import("inquirer");
  const { answer } = await inquirer.default.prompt<{ answer: string }>([
    {
      type: "input",
      name: "answer",
      message:
        `You are about to OVERWRITE the stored value of ${name} with the cleartext from ${sources}. ` +
        `The current stored value will be irrecoverable. Type 'yes' to confirm:`,
    },
  ]);
  return answer.trim() === "yes";
}
