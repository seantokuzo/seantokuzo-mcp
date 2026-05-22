/**
 * cipher.ts — AES-256-GCM header + AAD round-trip.
 *
 * Drives the round-trip API directly (no store, no key provider) so the
 * encrypt/decrypt failure modes are unambiguous. Tampering each header byte
 * AND the embedded generation triggers GCM verification failure.
 */

import { randomBytes } from "node:crypto";
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  decryptFile,
  encryptFile,
  FORMAT_VERSION,
  KDF_KEYCHAIN,
  KDF_SCRYPT,
  MAGIC,
} from "./cipher.js";
import { CredentialStoreError } from "./errors.js";

const KEY = Buffer.alloc(32, 0x42);
const PLAINTEXT = Buffer.from('{"version":1,"credentials":{"FOO":"bar"}}', "utf-8");

test("encryptFile + decryptFile round-trips in keychain mode", () => {
  const file = encryptFile({
    key: KEY,
    kdfId: KDF_KEYCHAIN,
    kdfParams: Buffer.alloc(0),
    generation: 1n,
    plaintext: PLAINTEXT,
  });
  const result = decryptFile({ key: KEY, file, expectedGeneration: 1n });
  assert.equal(result.plaintext.toString("utf-8"), PLAINTEXT.toString("utf-8"));
  assert.equal(result.kdfId, KDF_KEYCHAIN);
  assert.equal(result.kdfParams.length, 0);
  assert.equal(result.generation, 1n);
});

test("encryptFile + decryptFile round-trips in scrypt mode with a 16-byte salt", () => {
  const salt = randomBytes(16);
  const file = encryptFile({
    key: KEY,
    kdfId: KDF_SCRYPT,
    kdfParams: salt,
    generation: 42n,
    plaintext: PLAINTEXT,
  });
  const result = decryptFile({ key: KEY, file, expectedGeneration: 42n });
  assert.equal(result.plaintext.toString("utf-8"), PLAINTEXT.toString("utf-8"));
  assert.equal(result.kdfId, KDF_SCRYPT);
  assert.deepEqual(result.kdfParams, salt);
  assert.equal(result.generation, 42n);
});

test("file written has the documented header layout", () => {
  const file = encryptFile({
    key: KEY,
    kdfId: KDF_KEYCHAIN,
    kdfParams: Buffer.alloc(0),
    generation: 7n,
    plaintext: PLAINTEXT,
  });
  // Bytes 0..3 = MAGIC "KCR1"
  assert.deepEqual(file.subarray(0, 4), MAGIC);
  // Byte 4 = format version
  assert.equal(file.readUInt8(4), FORMAT_VERSION);
  // Byte 5 = KDF id
  assert.equal(file.readUInt8(5), KDF_KEYCHAIN);
  // Bytes 6..13 = generation (uint64 big-endian)
  assert.equal(file.readBigUInt64BE(6), 7n);
  // After generation: 12-byte nonce, then ciphertext, then 16-byte tag
  assert.ok(file.length >= 6 + 8 + 12 + 16, "file shorter than minimum");
});

test("magic-byte tamper fails decrypt with E_FILE_CORRUPTED", () => {
  const file = encryptFile({
    key: KEY,
    kdfId: KDF_KEYCHAIN,
    kdfParams: Buffer.alloc(0),
    generation: 1n,
    plaintext: PLAINTEXT,
  });
  file[0] = 0x00;
  assert.throws(
    () => decryptFile({ key: KEY, file }),
    (e: unknown): e is CredentialStoreError =>
      e instanceof CredentialStoreError &&
      e.code === "E_FILE_CORRUPTED" &&
      /magic bytes/i.test(e.message),
  );
});

test("version-byte tamper fails decrypt with E_FILE_CORRUPTED", () => {
  const file = encryptFile({
    key: KEY,
    kdfId: KDF_KEYCHAIN,
    kdfParams: Buffer.alloc(0),
    generation: 1n,
    plaintext: PLAINTEXT,
  });
  file[4] = 0xff;
  assert.throws(
    () => decryptFile({ key: KEY, file }),
    (e: unknown): e is CredentialStoreError =>
      e instanceof CredentialStoreError &&
      e.code === "E_FILE_CORRUPTED" &&
      /format_version/i.test(e.message),
  );
});

test("KDF-id tamper to unknown value fails decrypt with E_FILE_CORRUPTED", () => {
  const file = encryptFile({
    key: KEY,
    kdfId: KDF_KEYCHAIN,
    kdfParams: Buffer.alloc(0),
    generation: 1n,
    plaintext: PLAINTEXT,
  });
  file[5] = 0x7f;
  assert.throws(
    () => decryptFile({ key: KEY, file }),
    (e: unknown): e is CredentialStoreError =>
      e instanceof CredentialStoreError &&
      e.code === "E_FILE_CORRUPTED" &&
      /unknown kdf/i.test(e.message),
  );
});

test("salt tamper in scrypt mode fails AAD verification", () => {
  const salt = randomBytes(16);
  const file = encryptFile({
    key: KEY,
    kdfId: KDF_SCRYPT,
    kdfParams: salt,
    generation: 1n,
    plaintext: PLAINTEXT,
  });
  // Flip a byte inside the salt region (bytes 6..21).
  file.writeUInt8(file.readUInt8(10) ^ 0x80, 10);
  assert.throws(
    () => decryptFile({ key: KEY, file, expectedGeneration: 1n }),
    (e: unknown): e is CredentialStoreError =>
      e instanceof CredentialStoreError &&
      e.code === "E_FILE_CORRUPTED" &&
      /aes-gcm/i.test(e.message),
  );
});

test("generation tamper in the file is detected by the explicit live-counter check", () => {
  const file = encryptFile({
    key: KEY,
    kdfId: KDF_KEYCHAIN,
    kdfParams: Buffer.alloc(0),
    generation: 1n,
    plaintext: PLAINTEXT,
  });
  // Generation lives at bytes 6..13. Bump the last byte (gen 1 → 0).
  file.writeUInt8(file.readUInt8(13) ^ 0x01, 13);
  assert.throws(
    () => decryptFile({ key: KEY, file, expectedGeneration: 1n }),
    (e: unknown): e is CredentialStoreError =>
      e instanceof CredentialStoreError &&
      e.code === "E_FILE_CORRUPTED" &&
      /generation rollback/i.test(e.message),
  );
});

test("generation tamper without expectedGeneration is caught by AAD verification", () => {
  const file = encryptFile({
    key: KEY,
    kdfId: KDF_KEYCHAIN,
    kdfParams: Buffer.alloc(0),
    generation: 1n,
    plaintext: PLAINTEXT,
  });
  // Flip a byte inside the generation region. Without an expectedGeneration
  // override the rollback check is skipped, but the literal-bytes AAD still
  // differs from encrypt-time and GCM verify fails.
  file.writeUInt8(file.readUInt8(13) ^ 0x01, 13);
  assert.throws(
    () => decryptFile({ key: KEY, file }),
    (e: unknown): e is CredentialStoreError =>
      e instanceof CredentialStoreError &&
      e.code === "E_FILE_CORRUPTED" &&
      /aes-gcm/i.test(e.message),
  );
});

test("rollback attack — expectedGeneration > file_generation fails decrypt", () => {
  const file = encryptFile({
    key: KEY,
    kdfId: KDF_KEYCHAIN,
    kdfParams: Buffer.alloc(0),
    generation: 5n,
    plaintext: PLAINTEXT,
  });
  // Attacker restored an older snapshot whose generation is 5 while the live
  // counter has advanced to 6. AAD assembled from `expectedGeneration: 6n`
  // differs from the AAD that signed the file → GCM verify fails.
  assert.throws(
    () => decryptFile({ key: KEY, file, expectedGeneration: 6n }),
    (e: unknown): e is CredentialStoreError =>
      e instanceof CredentialStoreError && e.code === "E_FILE_CORRUPTED",
  );
});

test("wrong key fails AES-GCM verification", () => {
  const file = encryptFile({
    key: KEY,
    kdfId: KDF_KEYCHAIN,
    kdfParams: Buffer.alloc(0),
    generation: 1n,
    plaintext: PLAINTEXT,
  });
  const wrongKey = Buffer.alloc(32, 0x99);
  assert.throws(
    () => decryptFile({ key: wrongKey, file, expectedGeneration: 1n }),
    (e: unknown): e is CredentialStoreError =>
      e instanceof CredentialStoreError && e.code === "E_FILE_CORRUPTED",
  );
});

test("encryptFile rejects key of wrong length (E_INTERNAL)", () => {
  assert.throws(
    () =>
      encryptFile({
        key: Buffer.alloc(16),
        kdfId: KDF_KEYCHAIN,
        kdfParams: Buffer.alloc(0),
        generation: 1n,
        plaintext: PLAINTEXT,
      }),
    (e: unknown): e is CredentialStoreError =>
      e instanceof CredentialStoreError && e.code === "E_INTERNAL",
  );
});

test("encryptFile rejects mismatched kdfParams length (E_INTERNAL)", () => {
  // KEYCHAIN expects 0 bytes; passing 16 should reject.
  assert.throws(
    () =>
      encryptFile({
        key: KEY,
        kdfId: KDF_KEYCHAIN,
        kdfParams: Buffer.alloc(16),
        generation: 1n,
        plaintext: PLAINTEXT,
      }),
    (e: unknown): e is CredentialStoreError =>
      e instanceof CredentialStoreError && e.code === "E_INTERNAL",
  );
  // SCRYPT expects 16 bytes; passing 0 should reject.
  assert.throws(
    () =>
      encryptFile({
        key: KEY,
        kdfId: KDF_SCRYPT,
        kdfParams: Buffer.alloc(0),
        generation: 1n,
        plaintext: PLAINTEXT,
      }),
    (e: unknown): e is CredentialStoreError =>
      e instanceof CredentialStoreError && e.code === "E_INTERNAL",
  );
});

test("encryptFile rejects generation < 1 (E_INTERNAL)", () => {
  assert.throws(
    () =>
      encryptFile({
        key: KEY,
        kdfId: KDF_KEYCHAIN,
        kdfParams: Buffer.alloc(0),
        generation: 0n,
        plaintext: PLAINTEXT,
      }),
    (e: unknown): e is CredentialStoreError =>
      e instanceof CredentialStoreError && e.code === "E_INTERNAL",
  );
});

test("decryptFile rejects a too-short buffer with E_FILE_CORRUPTED", () => {
  assert.throws(
    () => decryptFile({ key: KEY, file: Buffer.alloc(4) }),
    (e: unknown): e is CredentialStoreError =>
      e instanceof CredentialStoreError &&
      e.code === "E_FILE_CORRUPTED" &&
      /too short/i.test(e.message),
  );
});

test("nonce is fresh per encryption (no determinism)", () => {
  const a = encryptFile({
    key: KEY,
    kdfId: KDF_KEYCHAIN,
    kdfParams: Buffer.alloc(0),
    generation: 1n,
    plaintext: PLAINTEXT,
  });
  const b = encryptFile({
    key: KEY,
    kdfId: KDF_KEYCHAIN,
    kdfParams: Buffer.alloc(0),
    generation: 1n,
    plaintext: PLAINTEXT,
  });
  // Same key + plaintext + gen → different ciphertext because nonce is random.
  assert.notDeepEqual(a, b);
});
