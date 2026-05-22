/**
 * key-provider.ts — InMemoryKeyProvider, PassphraseKeyProvider, NullKeyProvider.
 *
 * KeychainKeyProvider's keychain-touching paths are exercised only via the
 * `parseKeychainBlob` round-trip via the round-trip-on-set path covered in
 * `store.test.ts` against an InMemoryKeyProvider. The real keychain is
 * out-of-scope for unit tests.
 */

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { KeyProviderError } from "./errors.js";
import {
  InMemoryKeyProvider,
  NullKeyProvider,
  PassphraseKeyProvider,
} from "./key-provider.js";

// ─── InMemoryKeyProvider ───────────────────────────────────────────────────

test("InMemoryKeyProvider construction is guarded by NODE_ENV/KUZO_TEST", () => {
  const wasNodeEnv = process.env.NODE_ENV;
  const wasKuzoTest = process.env.KUZO_TEST;
  try {
    delete process.env.NODE_ENV;
    delete process.env.KUZO_TEST;
    assert.throws(
      () => new InMemoryKeyProvider(),
      (e: unknown): e is KeyProviderError =>
        e instanceof KeyProviderError && e.code === "E_TEST_ONLY",
    );
  } finally {
    if (wasNodeEnv !== undefined) process.env.NODE_ENV = wasNodeEnv;
    if (wasKuzoTest !== undefined) process.env.KUZO_TEST = wasKuzoTest;
  }
});

test("InMemoryKeyProvider initializeKey returns 32-byte key + empty kdfParams + gen=1", () => {
  const p = new InMemoryKeyProvider();
  const { key, kdfParams } = p.initializeKey();
  assert.equal(key.length, 32);
  assert.equal(kdfParams.length, 0);
  assert.equal(p.getGeneration(), 1n);
});

test("InMemoryKeyProvider acquireKey before initializeKey throws E_KEY_LOST", () => {
  const p = new InMemoryKeyProvider();
  assert.throws(
    () => p.acquireKey(Buffer.alloc(0)),
    (e: unknown): e is KeyProviderError =>
      e instanceof KeyProviderError && e.code === "E_KEY_LOST",
  );
});

test("InMemoryKeyProvider acquireKey is idempotent after initializeKey", () => {
  const p = new InMemoryKeyProvider();
  const { key } = p.initializeKey();
  assert.deepEqual(p.acquireKey(Buffer.alloc(0)), key);
  assert.deepEqual(p.acquireKey(Buffer.alloc(0)), key);
});

test("InMemoryKeyProvider seed key is used verbatim when supplied", () => {
  const seed = randomBytes(32);
  const p = new InMemoryKeyProvider({ key: seed });
  const { key } = p.initializeKey();
  assert.deepEqual(key, seed);
});

test("InMemoryKeyProvider rejects seed key of wrong length", () => {
  assert.throws(
    () => new InMemoryKeyProvider({ key: Buffer.alloc(16) }),
    (e: unknown): e is KeyProviderError =>
      e instanceof KeyProviderError && e.code === "E_KEY_INVALID",
  );
});

test("InMemoryKeyProvider bumpGeneration updates the cached counter", () => {
  const p = new InMemoryKeyProvider();
  p.initializeKey();
  p.bumpGeneration(2n);
  assert.equal(p.getGeneration(), 2n);
  p.bumpGeneration(3n);
  assert.equal(p.getGeneration(), 3n);
});

test("InMemoryKeyProvider bumpGeneration before initializeKey throws", () => {
  const p = new InMemoryKeyProvider();
  assert.throws(
    () => p.bumpGeneration(1n),
    (e: unknown): e is KeyProviderError =>
      e instanceof KeyProviderError && e.code === "E_KEY_LOST",
  );
});

test("InMemoryKeyProvider bumpGeneration rejects values < 1", () => {
  const p = new InMemoryKeyProvider();
  p.initializeKey();
  assert.throws(
    () => p.bumpGeneration(0n),
    (e: unknown): e is KeyProviderError =>
      e instanceof KeyProviderError && e.code === "E_KEY_INVALID",
  );
});

test("InMemoryKeyProvider wipeKeyCache clears state", () => {
  const p = new InMemoryKeyProvider();
  p.initializeKey();
  p.wipeKeyCache();
  assert.equal(p.getGeneration(), undefined);
  assert.throws(
    () => p.acquireKey(Buffer.alloc(0)),
    (e: unknown): e is KeyProviderError =>
      e instanceof KeyProviderError && e.code === "E_KEY_LOST",
  );
});

// ─── PassphraseKeyProvider ─────────────────────────────────────────────────

test("PassphraseKeyProvider rejects empty passphrase at construction", () => {
  assert.throws(
    () => new PassphraseKeyProvider(""),
    (e: unknown): e is KeyProviderError =>
      e instanceof KeyProviderError && e.code === "E_PASSPHRASE_EMPTY",
  );
});

test("PassphraseKeyProvider initializeKey returns 32-byte key + 16-byte salt", () => {
  const p = new PassphraseKeyProvider("correct horse battery staple");
  const { key, kdfParams } = p.initializeKey();
  assert.equal(key.length, 32);
  assert.equal(kdfParams.length, 16);
});

test("PassphraseKeyProvider derives the same key for the same passphrase+salt", () => {
  // Two providers, same passphrase, same salt → same derived key.
  const p1 = new PassphraseKeyProvider("xyzzy");
  const p2 = new PassphraseKeyProvider("xyzzy");
  const { key: a, kdfParams: salt } = p1.initializeKey();
  const b = p2.acquireKey(salt);
  assert.deepEqual(a, b);
});

test("PassphraseKeyProvider rejects salt of wrong size in acquireKey", () => {
  const p = new PassphraseKeyProvider("xyzzy");
  assert.throws(
    () => p.acquireKey(Buffer.alloc(0)),
    (e: unknown): e is KeyProviderError =>
      e instanceof KeyProviderError && e.code === "E_KEY_INVALID",
  );
  const q = new PassphraseKeyProvider("xyzzy");
  assert.throws(
    () => q.acquireKey(Buffer.alloc(8)),
    (e: unknown): e is KeyProviderError =>
      e instanceof KeyProviderError && e.code === "E_KEY_INVALID",
  );
});

test("PassphraseKeyProvider consumes the passphrase after first derivation", () => {
  // Note: the consumed passphrase doesn't block re-derivation via the CACHED
  // key — only re-derivation from scratch is blocked. acquireKey returns the
  // cached key indefinitely.
  const p = new PassphraseKeyProvider("xyzzy");
  const { key, kdfParams } = p.initializeKey();
  // After consume, re-deriving for the SAME provider returns the cached key.
  assert.deepEqual(p.acquireKey(kdfParams), key);
  // But initializeKey on the same instance refuses to roll a new salt+key
  // (would orphan the existing ciphertext).
  assert.throws(
    () => p.initializeKey(),
    (e: unknown): e is KeyProviderError =>
      e instanceof KeyProviderError && e.code === "E_PASSPHRASE_CONSUMED",
  );
});

test("PassphraseKeyProvider audit emit fires on initializeKey + acquireKey", () => {
  const events: Array<{ action: string; details: Record<string, unknown> }> = [];
  const auditLogger = {
    // Minimal duck-typed AuditLogger — captures the only method we use.
    log(event: { action: string; details: Record<string, unknown> }) {
      events.push({ action: event.action, details: event.details });
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = new PassphraseKeyProvider("xyzzy", auditLogger as any);
  const { kdfParams: salt } = p.initializeKey();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.action, "credential.passphrase_consumed");
  assert.equal(events[0]!.details.initialized, true);
  assert.equal(typeof events[0]!.details.salt_fingerprint, "string");
  assert.equal((events[0]!.details.salt_fingerprint as string).length, 16);

  // Second provider with same passphrase + the existing salt → acquireKey path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p2 = new PassphraseKeyProvider("xyzzy", auditLogger as any);
  p2.acquireKey(salt);
  assert.equal(events.length, 2);
  assert.equal(events[1]!.action, "credential.passphrase_consumed");
  assert.equal(events[1]!.details.initialized, false);
});

test("PassphraseKeyProvider wipeKeyCache clears the derived key", () => {
  const p = new PassphraseKeyProvider("xyzzy");
  p.initializeKey();
  p.wipeKeyCache();
  // After wipe, acquireKey throws because the passphrase was consumed and the
  // derived key is gone — re-derivation is impossible without a server restart.
  assert.throws(
    () => p.acquireKey(Buffer.alloc(16)),
    (e: unknown): e is KeyProviderError =>
      e instanceof KeyProviderError && e.code === "E_PASSPHRASE_CONSUMED",
  );
});

// ─── NullKeyProvider ───────────────────────────────────────────────────────

test("NullKeyProvider.acquireKey throws E_NO_STORAGE", () => {
  const p = new NullKeyProvider();
  assert.throws(
    () => p.acquireKey(Buffer.alloc(0)),
    (e: unknown): e is KeyProviderError =>
      e instanceof KeyProviderError && e.code === "E_NO_STORAGE",
  );
});

test("NullKeyProvider.initializeKey throws E_NO_STORAGE", () => {
  const p = new NullKeyProvider();
  assert.throws(
    () => p.initializeKey(),
    (e: unknown): e is KeyProviderError =>
      e instanceof KeyProviderError && e.code === "E_NO_STORAGE",
  );
});

test("NullKeyProvider has id='null' for status output", () => {
  assert.equal(new NullKeyProvider().id, "null");
});
