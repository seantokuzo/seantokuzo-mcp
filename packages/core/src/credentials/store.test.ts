/**
 * store.ts — EncryptedCredentialStore against a tmpdir + InMemoryKeyProvider.
 *
 * Covers the storage-primitive contract: lazy decrypt, file-not-found
 * short-circuit, atomic write, generation-persists-first ordering, KEY_LOST
 * state surfacing, rollback resistance. A single passphrase-mode test
 * exercises the `<filePath>.generation` file path that keychain mode bypasses.
 */

import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { CredentialStoreError, KeyProviderError } from "./errors.js";
import { NullKeyProvider, PassphraseKeyProvider } from "./key-provider.js";
import { EncryptedCredentialStore } from "./store.js";
import { InMemoryKeyProvider } from "./testing.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function freshTmp(t: TestContext): { dir: string; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "kuzo-store-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, filePath: join(dir, "credentials.enc") };
}

function makeStore(filePath: string, keyProvider = new InMemoryKeyProvider()) {
  return new EncryptedCredentialStore({ filePath, keyProvider });
}

// ─── Reads on an empty store ───────────────────────────────────────────────

test("get() on a missing file returns undefined without calling acquireKey", (t) => {
  const { filePath } = freshTmp(t);
  // NullKeyProvider would throw E_NO_STORAGE if acquireKey were called.
  const store = new EncryptedCredentialStore({ filePath, keyProvider: new NullKeyProvider() });
  assert.equal(store.get("FOO"), undefined);
  assert.equal(store.isUnlocked(), false);
  assert.equal(store.size, 0);
});

test("list() on a missing file returns []", (t) => {
  const { filePath } = freshTmp(t);
  const store = new EncryptedCredentialStore({ filePath, keyProvider: new NullKeyProvider() });
  assert.deepEqual(store.list(), []);
});

test("has() returns false on a never-unlocked store, even after get() of a missing key", (t) => {
  const { filePath } = freshTmp(t);
  const store = new EncryptedCredentialStore({ filePath, keyProvider: new NullKeyProvider() });
  assert.equal(store.has("FOO"), false);
  assert.equal(store.get("FOO"), undefined);
  // After a get() on a missing file, the store stays locked.
  assert.equal(store.has("FOO"), false);
  assert.equal(store.isUnlocked(), false);
});

// ─── Write round-trip ──────────────────────────────────────────────────────

test("set + get round-trips a credential through the encrypted file", (t) => {
  const { filePath } = freshTmp(t);
  const store = makeStore(filePath);
  store.set("GITHUB_TOKEN", "ghp_abcdef");
  assert.equal(store.get("GITHUB_TOKEN"), "ghp_abcdef");
  assert.ok(existsSync(filePath));
  // File on disk does NOT contain the cleartext value.
  const raw = readFileSync(filePath);
  assert.equal(raw.includes(Buffer.from("ghp_abcdef")), false);
  // After first write, store is unlocked + size = 1.
  assert.equal(store.isUnlocked(), true);
  assert.equal(store.size, 1);
});

test("multiple credentials persist independently and round-trip together", (t) => {
  const { filePath } = freshTmp(t);
  const store = makeStore(filePath);
  store.set("GITHUB_TOKEN", "gh-1");
  store.set("JIRA_API_TOKEN", "jira-1");
  store.set("JIRA_HOST", "kuzo.atlassian.net");
  assert.equal(store.get("GITHUB_TOKEN"), "gh-1");
  assert.equal(store.get("JIRA_API_TOKEN"), "jira-1");
  assert.equal(store.get("JIRA_HOST"), "kuzo.atlassian.net");
  assert.deepEqual(
    [...store.list()].sort(),
    ["GITHUB_TOKEN", "JIRA_API_TOKEN", "JIRA_HOST"],
  );
});

test("file is mode 0600 after rename (POSIX only)", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows ACL — fs.chmod 0600 is a no-op");
    return;
  }
  const { filePath } = freshTmp(t);
  const store = makeStore(filePath);
  store.set("FOO", "bar");
  const mode = statSync(filePath).mode & 0o777;
  assert.equal(mode, 0o600);
});

// ─── Persistence across store instances ────────────────────────────────────

test("a second store instance with the same keychain blob can decrypt and read", (t) => {
  const { filePath } = freshTmp(t);
  // Use a seed key so two InMemoryKeyProvider instances agree on the master key.
  const seed = Buffer.alloc(32, 0xaa);
  const p1 = new InMemoryKeyProvider({ key: seed });
  const p2 = new InMemoryKeyProvider({ key: seed });

  const store1 = new EncryptedCredentialStore({ filePath, keyProvider: p1 });
  store1.set("FOO", "bar");
  store1.set("BAZ", "qux");

  // For instance 2, manually replay the keychain blob's generation so the
  // store reads file_gen == live_gen. Real keychain mode auto-syncs because
  // the blob lives in the OS keychain, not in the provider.
  p2.initializeKey();
  // After write of 2 credentials, gen advanced to 2. Bump p2 to match.
  p2.bumpGeneration(2n);

  const store2 = new EncryptedCredentialStore({ filePath, keyProvider: p2 });
  assert.equal(store2.get("FOO"), "bar");
  assert.equal(store2.get("BAZ"), "qux");
  assert.equal(store2.size, 2);
});

// ─── Delete semantics ──────────────────────────────────────────────────────

test("delete(present) returns true + persists the removal", (t) => {
  const { filePath } = freshTmp(t);
  const store = makeStore(filePath);
  store.set("FOO", "1");
  store.set("BAR", "2");
  assert.equal(store.delete("FOO"), true);
  assert.equal(store.get("FOO"), undefined);
  assert.deepEqual(store.list(), ["BAR"]);
});

test("delete(absent) returns false and does NOT bump generation or write the file", (t) => {
  const { filePath } = freshTmp(t);
  const provider = new InMemoryKeyProvider();
  const store = new EncryptedCredentialStore({ filePath, keyProvider: provider });
  store.set("FOO", "1"); // generation now 1
  assert.equal(provider.getGeneration(), 1n);

  const fileBefore = readFileSync(filePath);
  assert.equal(store.delete("NOT_THERE"), false);
  assert.equal(provider.getGeneration(), 1n, "generation must not bump on no-op delete");
  assert.deepEqual(readFileSync(filePath), fileBefore, "file must not be rewritten on no-op delete");
});

test("delete on a missing file returns false without unlocking the store", (t) => {
  const { filePath } = freshTmp(t);
  const store = new EncryptedCredentialStore({ filePath, keyProvider: new NullKeyProvider() });
  assert.equal(store.delete("NOPE"), false);
  assert.equal(store.isUnlocked(), false);
});

// ─── reload() + close() ────────────────────────────────────────────────────

test("reload() re-reads from disk after an external mutation", (t) => {
  const { filePath } = freshTmp(t);
  const seed = Buffer.alloc(32, 0xbe);
  const p1 = new InMemoryKeyProvider({ key: seed });
  const store1 = new EncryptedCredentialStore({ filePath, keyProvider: p1 });
  store1.set("FOO", "v1");

  // Externally rewrite via a sibling store sharing the seed key.
  const p2 = new InMemoryKeyProvider({ key: seed });
  p2.initializeKey();
  p2.bumpGeneration(1n);
  const store2 = new EncryptedCredentialStore({ filePath, keyProvider: p2 });
  store2.set("FOO", "v2");

  // store1's cache still has v1; reload should pull in v2.
  assert.equal(store1.get("FOO"), "v1");
  // Sync p1's view of generation to the actual file before reload.
  p1.bumpGeneration(2n);
  store1.reload();
  assert.equal(store1.get("FOO"), "v2");
});

test("close() zeros the in-memory cache and calls provider.wipeKeyCache", (t) => {
  const { filePath } = freshTmp(t);
  const provider = new InMemoryKeyProvider();
  const store = new EncryptedCredentialStore({ filePath, keyProvider: provider });
  store.set("FOO", "bar");
  assert.equal(store.isUnlocked(), true);
  store.close();
  assert.equal(store.isUnlocked(), false);
  assert.equal(store.size, 0);
  // Provider has been wiped — getGeneration is undefined again.
  assert.equal(provider.getGeneration(), undefined);
});

test("close() emits credential.store_locked when an auditLogger is provided", (t) => {
  const { filePath } = freshTmp(t);
  const provider = new InMemoryKeyProvider();
  const events: Array<{ action: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const auditLogger: any = {
    log(event: { action: string }) {
      events.push({ action: event.action });
    },
  };
  const store = new EncryptedCredentialStore({ filePath, keyProvider: provider, auditLogger });
  store.set("FOO", "bar");
  // store_unlocked fires on the first decrypt — but the first `set` skips
  // unlock (the file didn't exist). A subsequent `get` triggers `unlockFromDisk`.
  store.close();
  // Only store_locked event fires here; store_unlocked requires a re-read.
  assert.deepEqual(events.map((e) => e.action), ["credential.store_locked"]);
});

test("close() called twice emits credential.store_locked only ONCE (round-2 A1)", (t) => {
  // Signal handlers + idempotent teardowns can legitimately call close()
  // more than once. The store_locked event should fire on the FIRST close
  // (the forensic signal "this process is shutting down its store") and
  // stay silent on subsequent calls, regardless of whether the cache was
  // ever populated.
  const { filePath } = freshTmp(t);
  const provider = new InMemoryKeyProvider();
  const events: Array<{ action: string; priorCount?: unknown }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const auditLogger: any = {
    log(event: { action: string; details?: { priorCount?: unknown } }) {
      events.push({ action: event.action, priorCount: event.details?.priorCount });
    },
  };
  const store = new EncryptedCredentialStore({ filePath, keyProvider: provider, auditLogger });
  store.set("FOO", "bar");
  store.close();
  store.close();
  store.close();
  const locked = events.filter((e) => e.action === "credential.store_locked");
  assert.equal(locked.length, 1, "exactly one credential.store_locked across three close() calls");
  assert.equal(locked[0]!.priorCount, 1, "priorCount reflects the FIRST close, not the third");
});

test("close() on a never-unlocked store STILL emits exactly once with priorCount=0 (round-2 A1)", (t) => {
  // The unconditional emit shape exists so forensics can correlate
  // "stopped without ever unlocking" against "stopped with N creds live."
  // A never-unlocked close must emit priorCount=0 — but only on the first
  // close, not on every repeat call.
  const { filePath } = freshTmp(t);
  const provider = new InMemoryKeyProvider();
  const events: Array<{ action: string; priorCount?: unknown }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const auditLogger: any = {
    log(event: { action: string; details?: { priorCount?: unknown } }) {
      events.push({ action: event.action, priorCount: event.details?.priorCount });
    },
  };
  const store = new EncryptedCredentialStore({ filePath, keyProvider: provider, auditLogger });
  // No set, no get — store remains never-unlocked.
  store.close();
  store.close();
  const locked = events.filter((e) => e.action === "credential.store_locked");
  assert.equal(locked.length, 1, "exactly one emit on never-unlocked store across two close() calls");
  assert.equal(locked[0]!.priorCount, 0);
});

test("get() after close() re-decrypts from disk and emits store_unlocked", (t) => {
  const { filePath } = freshTmp(t);
  const seed = Buffer.alloc(32, 0xcc);
  const provider = new InMemoryKeyProvider({ key: seed });
  const events: Array<{ action: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const auditLogger: any = {
    log(event: { action: string }) {
      events.push({ action: event.action });
    },
  };
  const store = new EncryptedCredentialStore({ filePath, keyProvider: provider, auditLogger });
  store.set("FOO", "bar");
  store.close();
  // After close, provider was wiped. Re-prime to mirror the on-disk gen=1.
  provider.initializeKey();
  provider.bumpGeneration(1n);
  assert.equal(store.get("FOO"), "bar");
  assert.ok(events.some((e) => e.action === "credential.store_unlocked"));
});

// ─── Generation counter behavior ───────────────────────────────────────────

test("generation bumps by 1 on every write", (t) => {
  const { filePath } = freshTmp(t);
  const provider = new InMemoryKeyProvider();
  const store = new EncryptedCredentialStore({ filePath, keyProvider: provider });
  store.set("A", "1");
  assert.equal(provider.getGeneration(), 1n);
  store.set("B", "2");
  assert.equal(provider.getGeneration(), 2n);
  store.set("A", "1-updated");
  assert.equal(provider.getGeneration(), 3n);
  store.delete("B");
  assert.equal(provider.getGeneration(), 4n);
});

test("rollback attack — restoring an older file fails decrypt as E_FILE_CORRUPTED", (t) => {
  const { filePath } = freshTmp(t);
  const provider = new InMemoryKeyProvider();
  const store = new EncryptedCredentialStore({ filePath, keyProvider: provider });
  store.set("FOO", "v1");
  const snapshotV1 = readFileSync(filePath);
  store.set("FOO", "v2");
  // Restore the gen=1 file while live counter says gen=2. `reload()` discards
  // the cache + triggers re-decrypt — the rollback check fires there.
  writeFileSync(filePath, snapshotV1);
  assert.throws(
    () => store.reload(),
    (e: unknown): e is CredentialStoreError =>
      e instanceof CredentialStoreError &&
      e.code === "E_FILE_CORRUPTED" &&
      /generation rollback/i.test(e.message),
  );
});

// ─── KEY_LOST surfacing ────────────────────────────────────────────────────

test("KEY_LOST surfaces when the file exists but the provider lost the key", (t) => {
  const { filePath } = freshTmp(t);
  const provider1 = new InMemoryKeyProvider();
  const store1 = new EncryptedCredentialStore({ filePath, keyProvider: provider1 });
  store1.set("FOO", "bar");

  // New provider with no key — simulates wiped keychain entry while file remains.
  const provider2 = new InMemoryKeyProvider();
  const store2 = new EncryptedCredentialStore({ filePath, keyProvider: provider2 });
  assert.throws(
    () => store2.get("FOO"),
    (e: unknown): e is KeyProviderError =>
      e instanceof KeyProviderError && e.code === "E_KEY_LOST",
  );
});

// ─── Passphrase mode (scrypt + .generation file) ───────────────────────────

test("passphrase mode writes a .generation file and bumps it on every write", (t) => {
  const { filePath } = freshTmp(t);
  const provider = new PassphraseKeyProvider("correct horse battery staple");
  const generationFilePath = `${filePath}.generation`;
  const store = new EncryptedCredentialStore({
    filePath,
    keyProvider: provider,
    generationFilePath,
  });

  store.set("FOO", "bar");
  assert.ok(existsSync(generationFilePath), ".generation file must be written");
  assert.equal(readFileSync(generationFilePath, "utf-8").trim(), "1");

  // For subsequent writes, the provider's cached key reuses the same salt
  // (it derived the key in initializeKey from a fresh salt and won't re-derive).
  store.set("BAZ", "qux");
  assert.equal(readFileSync(generationFilePath, "utf-8").trim(), "2");
  // Round-trip the value through the encrypted file.
  store.close();

  // New provider, new salt would fail. To re-decrypt we need the SAME passphrase
  // + the SAME salt embedded in the file header. A second provider derives the
  // key from the file's salt — wire it up via acquireKey + bumpGeneration sync.
  // For this test we just confirm the value persisted on disk + .generation
  // tracks correctly; the cross-instance decrypt path is exercised by the
  // keychain-mode persistence test above.
  assert.equal(readFileSync(generationFilePath, "utf-8").trim(), "2");
});

test("passphrase mode + second provider round-trips via file salt", (t) => {
  const { filePath } = freshTmp(t);
  const generationFilePath = `${filePath}.generation`;

  const p1 = new PassphraseKeyProvider("xyzzy-and-a-half");
  const store1 = new EncryptedCredentialStore({
    filePath,
    keyProvider: p1,
    generationFilePath,
  });
  store1.set("FOO", "bar");

  // Second provider derives the key from the file's embedded salt; the
  // .generation file says gen=1 so AAD matches.
  const p2 = new PassphraseKeyProvider("xyzzy-and-a-half");
  const store2 = new EncryptedCredentialStore({
    filePath,
    keyProvider: p2,
    generationFilePath,
  });
  assert.equal(store2.get("FOO"), "bar");
});

// ─── Header / payload corruption ───────────────────────────────────────────

test("truncated credentials.enc fails decrypt as E_FILE_CORRUPTED", (t) => {
  const { filePath } = freshTmp(t);
  const provider = new InMemoryKeyProvider();
  const store = new EncryptedCredentialStore({ filePath, keyProvider: provider });
  store.set("FOO", "bar");
  // Truncate the file mid-ciphertext (after magic+gen header, before tag).
  const raw = readFileSync(filePath);
  writeFileSync(filePath, raw.subarray(0, raw.length - 8));
  assert.throws(
    () => store.reload(),
    (e: unknown): e is CredentialStoreError =>
      e instanceof CredentialStoreError && e.code === "E_FILE_CORRUPTED",
  );
});

test("garbage credentials.enc with no KCR1 magic fails as E_FILE_CORRUPTED", (t) => {
  const { filePath } = freshTmp(t);
  // Make a fake file with enough bytes to pass the length pre-check.
  writeFileSync(filePath, Buffer.alloc(64, 0xff));
  const store = new EncryptedCredentialStore({ filePath, keyProvider: new InMemoryKeyProvider() });
  assert.throws(
    () => store.get("FOO"),
    (e: unknown): e is CredentialStoreError =>
      e instanceof CredentialStoreError && e.code === "E_FILE_CORRUPTED",
  );
});

// ─── Backend identity ──────────────────────────────────────────────────────

test("backend identity reflects the key provider", (t) => {
  const { filePath } = freshTmp(t);
  const s1 = new EncryptedCredentialStore({ filePath, keyProvider: new InMemoryKeyProvider() });
  assert.equal(s1.backend, "memory");
  const s2 = new EncryptedCredentialStore({ filePath, keyProvider: new NullKeyProvider() });
  assert.equal(s2.backend, "null");
});
