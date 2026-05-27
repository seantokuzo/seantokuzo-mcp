/**
 * migrate.test.ts — Phase 2.6 §B.4 orchestration: classify → import →
 * read-back → redact, plus the conflict / force / dry-run / partial-success /
 * rollback branches and the audit shapes they emit.
 *
 * Uses a real EncryptedCredentialStore over an InMemoryKeyProvider + temp files
 * so imports, redaction, and the generation counter all exercise real code; the
 * lock and prompts are stubbed via MigrateDeps.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type { AuditEvent, AuditLogger } from "@kuzo-mcp/core/audit";
import {
  EncryptedCredentialStore,
  KDF_KEYCHAIN,
  KeyProviderError,
  type CredentialStore,
  type KeyProvider,
} from "@kuzo-mcp/core/credentials";

import { NOOP_LOCK } from "../../lock.js";
import { CRED_EXIT } from "./errors.js";
import type { MigrateSource } from "./migrate-discovery.js";
import {
  defaultMigrateDeps,
  runMigrate,
  type CredentialsMigrateOptions,
  type MigrateDeps,
} from "./migrate.js";
import type { StoreContext } from "./store-access.js";

/**
 * Keychain-mode test key provider whose key + generation survive `close()`'s
 * `wipeKeyCache()` (a real OS keychain persists too), so a test can re-read the
 * committed file after `runMigrate` closes the store.
 */
class PersistentMemoryKeyProvider implements KeyProvider {
  readonly id = "memory";
  readonly kdfId = KDF_KEYCHAIN;
  private key: Buffer | undefined;
  private gen: bigint | undefined;
  acquireKey(): Buffer {
    if (!this.key) throw new KeyProviderError("E_KEY_LOST", "no key initialized");
    return this.key;
  }
  initializeKey(): { key: Buffer; kdfParams: Buffer } {
    this.key = Buffer.alloc(32, 7);
    this.gen = 1n;
    return { key: this.key, kdfParams: Buffer.alloc(0) };
  }
  getGeneration(): bigint | undefined {
    return this.gen;
  }
  bumpGeneration(g: bigint): void {
    this.gen = g;
  }
  wipeKeyCache(): void {
    /* intentionally persist across close so tests can re-read */
  }
}

class CapturingAudit implements AuditLogger {
  events: Array<Omit<AuditEvent, "timestamp">> = [];
  log(event: Omit<AuditEvent, "timestamp">): void {
    this.events.push(event);
  }
  query(): AuditEvent[] {
    return this.events.map((e) => ({ ...e, timestamp: new Date(0).toISOString() }));
  }
  byAction(action: string): Array<Omit<AuditEvent, "timestamp">> {
    return this.events.filter((e) => e.action === action);
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kuzo-migrate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function options(over: Partial<CredentialsMigrateOptions> = {}): CredentialsMigrateOptions {
  return { source: "both", dryRun: false, forceSource: false, yes: true, ...over };
}

function envSource(name: string, lines: string): { source: MigrateSource; path: string } {
  const path = join(dir, `${name}.env`);
  writeFileSync(path, lines);
  // Parse the known creds out of the written file for the source's entries.
  const entries = new Map<string, string>();
  return { source: { kind: "env-file", path, entries }, path };
}

/** Build a real store-backed deps with stubbed lock + prompts. */
function makeDeps(
  sources: MigrateSource[],
  over: Partial<MigrateDeps> = {},
): { deps: MigrateDeps; store: CredentialStore; audit: CapturingAudit } {
  const credentialsFile = join(dir, "credentials.enc");
  const audit = new CapturingAudit();
  const keyProvider = new PersistentMemoryKeyProvider();
  const store = new EncryptedCredentialStore({ filePath: credentialsFile, keyProvider, auditLogger: audit });
  const ctx: StoreContext = { store, keyProvider, audit };
  const deps: MigrateDeps = {
    discover: () => sources,
    openStore: () => ctx,
    acquireLock: async () => NOOP_LOCK,
    knownEnvNames: () => new Set(["GITHUB_TOKEN", "JIRA_API_TOKEN"]),
    credentialsFile,
    generationFile: `${credentialsFile}.generation`,
    confirm: async () => true,
    forceConfirm: async () => true,
    log: () => {},
    ...over,
  };
  return { deps, store, audit };
}

function exitCodeOf(p: Promise<unknown>): Promise<number | undefined> {
  return p.then(
    () => undefined,
    (err) => (err as { exitCode?: number }).exitCode,
  );
}

test("new credential: imported, source redacted, credential.migrated emitted", async () => {
  const { source, path } = envSource("project", "GITHUB_TOKEN=ghp_new\nLOG_LEVEL=info\n");
  source.entries.set("GITHUB_TOKEN", "ghp_new");
  const { deps, store, audit } = makeDeps([source]);

  await runMigrate(options(), deps);

  // A fresh store instance reads the just-written file from disk.
  assert.equal(reopen(deps).get("GITHUB_TOKEN"), "ghp_new");
  const after = readFileSync(path, "utf-8");
  assert.ok(!after.includes("ghp_new"), "secret redacted from source");
  assert.ok(after.includes("LOG_LEVEL=info"), "non-cred line preserved");

  const migrated = audit.byAction("credential.migrated");
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0]?.details.credentialKey, "GITHUB_TOKEN");
  assert.equal(migrated[0]?.details.source, "env-file");
  store.close();
});

test("already-migrated: store has same value → rewrite-only, no credential.migrated", async () => {
  const { source, path } = envSource("project", "GITHUB_TOKEN=ghp_same\n");
  source.entries.set("GITHUB_TOKEN", "ghp_same");
  const { deps, store, audit } = makeDeps([source]);
  store.set("GITHUB_TOKEN", "ghp_same"); // pre-seed
  audit.events.length = 0; // ignore the pre-seed's events

  await runMigrate(options(), deps);

  assert.equal(reopen(deps).get("GITHUB_TOKEN"), "ghp_same");
  assert.ok(!readFileSync(path, "utf-8").includes("ghp_same"), "source still redacted");
  assert.equal(audit.byAction("credential.migrated").length, 0, "no re-import");
  assert.equal(audit.byAction("credential.set").length, 0);
  store.close();
});

test("conflict without --force-source → E_CONFLICT (77), store + source untouched", async () => {
  const { source, path } = envSource("project", "GITHUB_TOKEN=ghp_source\n");
  source.entries.set("GITHUB_TOKEN", "ghp_source");
  const { deps, store } = makeDeps([source]);
  store.set("GITHUB_TOKEN", "ghp_stored"); // different value already stored

  const code = await exitCodeOf(runMigrate(options(), deps));
  assert.equal(code, CRED_EXIT.E_CONFLICT);
  assert.equal(reopen(deps).get("GITHUB_TOKEN"), "ghp_stored", "store unchanged");
  assert.ok(readFileSync(path, "utf-8").includes("ghp_source"), "source not redacted on conflict");
  store.close();
});

test("--force-source: overwrites the store and audits credential.set with the reason", async () => {
  const { source, path } = envSource("project", "GITHUB_TOKEN=ghp_forced\n");
  source.entries.set("GITHUB_TOKEN", "ghp_forced");
  const { deps, store, audit } = makeDeps([source]);
  store.set("GITHUB_TOKEN", "ghp_stored");
  audit.events.length = 0;

  await runMigrate(options({ forceSource: true, yes: false }), deps);

  assert.equal(reopen(deps).get("GITHUB_TOKEN"), "ghp_forced", "store overwritten");
  assert.ok(!readFileSync(path, "utf-8").includes("ghp_forced"), "source redacted");
  const sets = audit.byAction("credential.set");
  assert.equal(sets.length, 1);
  assert.equal(sets[0]?.details.reason, "migrate --force-source");
  store.close();
});

test("--force-source with --yes is rejected (E_INVALID_FLAG_COMBO 63)", async () => {
  const { deps } = makeDeps([]);
  const code = await exitCodeOf(runMigrate(options({ forceSource: true, yes: true }), deps));
  assert.equal(code, CRED_EXIT.E_INVALID_FLAG_COMBO);
});

test("--dry-run touches nothing: no lock, no store, source intact", async () => {
  const { source, path } = envSource("project", "GITHUB_TOKEN=ghp_x\n");
  source.entries.set("GITHUB_TOKEN", "ghp_x");
  const { deps } = makeDeps([source], {
    acquireLock: async () => {
      throw new Error("dry-run must not acquire the lock");
    },
    openStore: () => {
      throw new Error("dry-run must not open the store");
    },
  });

  await runMigrate(options({ dryRun: true }), deps);

  assert.ok(!existsSync(deps.credentialsFile), "no store written");
  assert.ok(readFileSync(path, "utf-8").includes("ghp_x"), "source untouched");
});

test("read-back failure rolls back the store and exits E_READBACK_FAIL (60)", async () => {
  const { source, path } = envSource("project", "GITHUB_TOKEN=ghp_x\n");
  source.entries.set("GITHUB_TOKEN", "ghp_x");

  // Store stub: absent until set, then returns a corrupted value on read-back.
  const map = new Map<string, string>();
  const fakeStore: CredentialStore = {
    get: (k) => (map.has(k) ? "CORRUPTED" : undefined),
    set: (k, v) => map.set(k, v),
    delete: (k) => map.delete(k),
    list: () => [...map.keys()],
    has: (k) => map.has(k),
    isUnlocked: () => true,
    reload: () => {},
    close: () => {},
    get size() {
      return map.size;
    },
    backend: "memory",
  };
  const audit = new CapturingAudit();
  const keyProvider = new PersistentMemoryKeyProvider();
  const { deps } = makeDeps([source], {
    openStore: () => ({ store: fakeStore, keyProvider, audit }),
  });

  const code = await exitCodeOf(runMigrate(options(), deps));
  assert.equal(code, CRED_EXIT.E_READBACK_FAIL);
  const partial = audit.byAction("credential.migration_partial");
  assert.equal(partial.length, 1);
  assert.equal(partial[0]?.details.reason, "read_back_mismatch");
  assert.equal(partial[0]?.details.rollback_attempted, true);
  assert.ok(readFileSync(path, "utf-8").includes("ghp_x"), "source not redacted (failed before rewrite)");
});

test("partial success: a value left in a .env comment fails verify but keeps the import", async () => {
  const clean = envSource("clean", "GITHUB_TOKEN=ghp_clean\n");
  clean.source.entries.set("GITHUB_TOKEN", "ghp_clean");
  // The secret is also pasted into a comment — redaction drops the assignment
  // but the comment retains the value, so the fragment backstop must trip.
  const leaky = envSource("leaky", "JIRA_API_TOKEN=jira_xyz123\n# old token: jira_xyz123\n");
  leaky.source.entries.set("JIRA_API_TOKEN", "jira_xyz123");

  const { deps, store, audit } = makeDeps([clean.source, leaky.source]);

  const code = await exitCodeOf(runMigrate(options(), deps));
  assert.equal(code, CRED_EXIT.E_REDACTION_VERIFY_FAIL);

  // Both credentials still imported (no store rollback in the partial path).
  const fresh = reopen(deps);
  assert.equal(fresh.get("GITHUB_TOKEN"), "ghp_clean");
  assert.equal(fresh.get("JIRA_API_TOKEN"), "jira_xyz123");
  // Clean source redacted; leaky source still holds the comment copy.
  assert.ok(!readFileSync(clean.path, "utf-8").includes("ghp_clean"));
  assert.ok(readFileSync(leaky.path, "utf-8").includes("jira_xyz123"));
  assert.equal(audit.byAction("credential.migrated").length, 2);
  const partial = audit.byAction("credential.migration_partial");
  assert.equal(partial.length, 1);
  assert.equal(partial[0]?.details.source, leaky.path);
  store.close();
});

test("no candidates: prints nothing-to-migrate and never locks", async () => {
  let locked = false;
  const { deps } = makeDeps([], { acquireLock: async () => { locked = true; return NOOP_LOCK; } });
  await runMigrate(options(), deps);
  assert.equal(locked, false);
});

test("defaultMigrateDeps wires the real credentials file path", () => {
  const deps = defaultMigrateDeps();
  assert.ok(deps.credentialsFile.endsWith("credentials.enc"));
  assert.equal(deps.generationFile, `${deps.credentialsFile}.generation`);
});

/**
 * Read committed state back. `runMigrate`'s finally already closed the store
 * (wiping its cache), but the test provider's no-op `wipeKeyCache` keeps the key
 * alive, so the same store re-decrypts lazily from disk on the next `get()`.
 */
function reopen(deps: MigrateDeps): CredentialStore {
  return deps.openStore().store;
}
