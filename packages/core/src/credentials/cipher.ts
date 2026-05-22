/**
 * AES-256-GCM encrypt/decrypt with the `credentials.enc` header format
 * (spec §A.2 + §A.3).
 *
 *   0       4       Magic            "KCR1"
 *   4       1       Format version   0x01
 *   5       1       KDF id           0x00 keychain | 0x01 scrypt
 *   6       p       KDF params       0 bytes (keychain) | 16-byte salt (scrypt)
 *   6+p     8       Generation       big-endian uint64
 *   ─────────────── AAD ends here ────────────────
 *   6+p+8   12      Nonce            random per encryption
 *   6+p+20  N       Ciphertext
 *   end-16  16      Tag              GCM authentication tag
 *
 * Two defenses layered together (spec §A.3):
 *
 *   1. **AAD = literal header bytes** (`file.subarray(0, headerEnd)`). Tamper
 *      with any header byte — version downgrade, KDF id swap, salt rewrite,
 *      generation byte flip — invalidates GCM verification.
 *
 *   2. **Explicit generation check.** `decryptFile` rejects when the file's
 *      embedded generation differs from the caller-supplied `expectedGeneration`
 *      (the live counter from keychain blob / `credentials.generation`). A
 *      full-file rollback (attacker restored a stale snapshot whose header is
 *      unchanged) bypasses defense 1 but not this one.
 *
 * Plaintext is opaque to this layer — the store JSON-encodes its map and hands
 * a `Buffer` over. Callers handle UTF-8.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { CredentialStoreError } from "./errors.js";

// ─── Constants ─────────────────────────────────────────────────────────────

/** "KCR1" — Kuzo CRedentials format 1. Header bytes 0..3. */
export const MAGIC = Buffer.from("KCR1", "ascii");
export const FORMAT_VERSION = 0x01;

export const KDF_KEYCHAIN = 0x00;
export const KDF_SCRYPT = 0x01;
export type KdfId = typeof KDF_KEYCHAIN | typeof KDF_SCRYPT;

const NONCE_LEN = 12;
const TAG_LEN = 16;
const GEN_LEN = 8;
const SCRYPT_SALT_LEN = 16;
const HEADER_FIXED_LEN = 6; // magic(4) + version(1) + kdfId(1)
const KEY_LEN = 32;

// ─── Public types ──────────────────────────────────────────────────────────

export interface EncryptFileInput {
  key: Buffer;
  kdfId: KdfId;
  /** 0 bytes for keychain, 16 bytes for scrypt. */
  kdfParams: Buffer;
  /** Monotonic counter — bumped by the store on every write. */
  generation: bigint;
  /** Cleartext payload (typically UTF-8 JSON of the credentials map). */
  plaintext: Buffer;
}

export interface DecryptFileInput {
  key: Buffer;
  file: Buffer;
  /**
   * The live generation counter from the source of truth (keychain blob for
   * keychain mode, `credentials.generation` for passphrase mode). When
   * supplied, `decryptFile` rejects with `E_FILE_CORRUPTED` if the file's
   * embedded generation differs — that's the rollback-attack defense.
   *
   * Pass `undefined` to skip the rollback check (one-shot recovery tooling);
   * AAD verification still runs and detects any header-byte tamper.
   */
  expectedGeneration?: bigint;
}

export interface DecryptFileResult {
  plaintext: Buffer;
  kdfId: KdfId;
  kdfParams: Buffer;
  generation: bigint;
}

// ─── Header helpers ────────────────────────────────────────────────────────

function expectedKdfParamsLength(kdfId: KdfId): number {
  switch (kdfId) {
    case KDF_KEYCHAIN:
      return 0;
    case KDF_SCRYPT:
      return SCRYPT_SALT_LEN;
  }
}

function serializeHeader(
  kdfId: KdfId,
  kdfParams: Buffer,
  generation: bigint,
): Buffer {
  const header = Buffer.alloc(HEADER_FIXED_LEN + kdfParams.length + GEN_LEN);
  MAGIC.copy(header, 0);
  header.writeUInt8(FORMAT_VERSION, 4);
  header.writeUInt8(kdfId, 5);
  kdfParams.copy(header, HEADER_FIXED_LEN);
  header.writeBigUInt64BE(generation, HEADER_FIXED_LEN + kdfParams.length);
  return header;
}

// ─── Encrypt / decrypt ─────────────────────────────────────────────────────

export function encryptFile(input: EncryptFileInput): Buffer {
  if (input.key.length !== KEY_LEN) {
    throw new CredentialStoreError(
      "E_INTERNAL",
      `encryptFile: key must be ${KEY_LEN} bytes; got ${input.key.length}`,
    );
  }
  const expectedParamsLen = expectedKdfParamsLength(input.kdfId);
  if (input.kdfParams.length !== expectedParamsLen) {
    throw new CredentialStoreError(
      "E_INTERNAL",
      `encryptFile: kdfParams must be ${expectedParamsLen} bytes for kdfId=0x${input.kdfId.toString(16).padStart(2, "0")}; got ${input.kdfParams.length}`,
    );
  }
  if (input.generation < 1n) {
    throw new CredentialStoreError(
      "E_INTERNAL",
      `encryptFile: generation must be >= 1; got ${input.generation}`,
    );
  }

  const header = serializeHeader(input.kdfId, input.kdfParams, input.generation);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", input.key, nonce);
  // AAD is the literal header buffer — any header-byte tamper on decrypt
  // produces a different AAD and fails GCM verification.
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([header, nonce, ciphertext, tag]);
}

export function decryptFile(input: DecryptFileInput): DecryptFileResult {
  if (input.key.length !== KEY_LEN) {
    throw new CredentialStoreError(
      "E_INTERNAL",
      `decryptFile: key must be ${KEY_LEN} bytes; got ${input.key.length}`,
    );
  }
  const { file } = input;

  if (file.length < HEADER_FIXED_LEN + GEN_LEN + NONCE_LEN + TAG_LEN) {
    throw new CredentialStoreError(
      "E_FILE_CORRUPTED",
      `credentials.enc is too short to contain a valid header (${file.length} bytes)`,
    );
  }
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new CredentialStoreError(
      "E_FILE_CORRUPTED",
      `credentials.enc magic bytes do not match "KCR1" — file is not a kuzo credential blob (or it is from a future format version that has not been backported here)`,
    );
  }
  const version = file.readUInt8(4);
  if (version !== FORMAT_VERSION) {
    throw new CredentialStoreError(
      "E_FILE_CORRUPTED",
      `Unsupported credentials.enc format_version ${version}; expected ${FORMAT_VERSION}`,
    );
  }
  const kdfIdRaw = file.readUInt8(5);
  if (kdfIdRaw !== KDF_KEYCHAIN && kdfIdRaw !== KDF_SCRYPT) {
    throw new CredentialStoreError(
      "E_FILE_CORRUPTED",
      `Unknown KDF id 0x${kdfIdRaw.toString(16).padStart(2, "0")} in credentials.enc header`,
    );
  }
  const kdfId = kdfIdRaw as KdfId;
  const expectedParamsLen = expectedKdfParamsLength(kdfId);
  // Bounds-check before slicing so a malformed file doesn't read past EOF.
  const minLen =
    HEADER_FIXED_LEN + expectedParamsLen + GEN_LEN + NONCE_LEN + TAG_LEN;
  if (file.length < minLen) {
    throw new CredentialStoreError(
      "E_FILE_CORRUPTED",
      `credentials.enc is shorter than the header declares (${file.length} < ${minLen}); declared kdfId=0x${kdfId.toString(16).padStart(2, "0")} requires ${expectedParamsLen}-byte KDF params`,
    );
  }

  const kdfParams = Buffer.from(
    file.subarray(HEADER_FIXED_LEN, HEADER_FIXED_LEN + expectedParamsLen),
  );
  const fileGeneration = file.readBigUInt64BE(
    HEADER_FIXED_LEN + expectedParamsLen,
  );
  const aadEnd = HEADER_FIXED_LEN + expectedParamsLen + GEN_LEN;
  const nonce = file.subarray(aadEnd, aadEnd + NONCE_LEN);
  const ciphertext = file.subarray(aadEnd + NONCE_LEN, file.length - TAG_LEN);
  const tag = file.subarray(file.length - TAG_LEN);

  // Defense 2 (rollback): explicit comparison against caller-supplied live
  // counter. The literal-bytes AAD below can't catch a clean snapshot rollback
  // because the file's header bytes are unchanged — only the live counter
  // diverged.
  if (
    input.expectedGeneration !== undefined &&
    input.expectedGeneration !== fileGeneration
  ) {
    throw new CredentialStoreError(
      "E_FILE_CORRUPTED",
      `credentials.enc generation rollback detected: file=${fileGeneration} live=${input.expectedGeneration}. Either a stale snapshot was restored or the live counter is corrupt. Run \`kuzo credentials wipe --confirm\` to start over.`,
    );
  }

  // Defense 1 (header tamper): AAD = literal header bytes from the file.
  const aad = file.subarray(0, aadEnd);

  const decipher = createDecipheriv("aes-256-gcm", input.key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Node throws "Unsupported state or unable to authenticate data" on tag
    // mismatch. Translate to the user-visible state machine error code; no
    // stack-trace passthrough (the underlying error doesn't add information).
    throw new CredentialStoreError(
      "E_FILE_CORRUPTED",
      "credentials.enc failed AES-GCM authentication — header tamper, wrong master key, OR a stale snapshot was restored. Run `kuzo credentials wipe --confirm` to start over.",
    );
  }

  return { plaintext, kdfId, kdfParams, generation: fileGeneration };
}
