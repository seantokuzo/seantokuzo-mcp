/**
 * KeyProvider — acquires the AES-256 master key used by the credential store.
 *
 * Four implementations (spec §A.5):
 *   - KeychainKeyProvider     — OS keychain via `@napi-rs/keyring`. Primary path.
 *   - PassphraseKeyProvider   — scrypt KDF over `KUZO_PASSPHRASE` env var. Headless / CI.
 *   - NullKeyProvider         — env-override-only sentinel. Refuses to touch storage.
 *   - InMemoryKeyProvider     — test double. Guarded by `NODE_ENV=test` / `KUZO_TEST=1`.
 *
 * Constructor side-effect freedom invariant (spec §A.5):
 * No I/O, no dbus calls, no Keychain Services calls in constructors. All
 * external interaction happens in `acquireKey()` / `initializeKey()` — both
 * called AFTER the `process.env` scrub completes at boot. The `Entry` object
 * referenced by `KeychainKeyProvider.entry` is lazily bound by
 * `@napi-rs/keyring`; first real call happens inside `acquireKey()`.
 */

import { createHash, randomBytes, scryptSync } from "node:crypto";

import { Entry } from "@napi-rs/keyring";

import type { AuditLogger } from "../audit.js";
import { KDF_KEYCHAIN, KDF_SCRYPT, type KdfId } from "./cipher.js";
import { KeyProviderError } from "./errors.js";

// ─── Public interface ──────────────────────────────────────────────────────

export interface KeyProvider {
  /** Backend identity ("keychain" | "passphrase" | "null" | "memory"). */
  readonly id: string;

  /** KDF id byte written into the file header. */
  readonly kdfId: KdfId;

  /**
   * Acquire the master key. May prompt the user (keychain on macOS first run)
   * or run a KDF (passphrase). Returns a 32-byte Buffer. Caches internally;
   * subsequent calls are cheap.
   *
   * `headerKdfParams` is the KDF params block read from the file header (the
   * 16-byte salt for scrypt mode; empty Buffer for keychain mode). Providers
   * that don't need it (keychain, memory) ignore it.
   */
  acquireKey(headerKdfParams: Buffer): Buffer;

  /**
   * Generate a fresh master key and persist it (keychain) or capture the salt
   * (passphrase). Called when the credential file does not yet exist.
   *
   * Returns the new key plus the KDF params block to write into the header
   * (16-byte salt for scrypt; empty Buffer for keychain).
   */
  initializeKey(): { key: Buffer; kdfParams: Buffer };

  /**
   * Read the live generation counter, if this provider co-locates it with the
   * master key (keychain, memory). Undefined for providers that don't —
   * `PassphraseKeyProvider` keeps the generation in a separate file managed
   * by the store.
   *
   * Returns `undefined` BEFORE the first `acquireKey()` / `initializeKey()`
   * even on providers that implement this method, because the value is read
   * alongside the key.
   */
  getGeneration?(): bigint | undefined;

  /**
   * Atomically persist a new generation counter. Called from the store's
   * write path between encryption and `rename` (§A.3 step 10). Only available
   * on providers that implement `getGeneration`.
   */
  bumpGeneration?(newGeneration: bigint): void;

  /**
   * Zero any cached secret material held by this provider. Called from the
   * store's `close()` at server shutdown. Always-honest semantics — strings
   * cannot be reliably zeroed in V8 (see `consumePassphrase` note), so this
   * primarily drops Buffer references after `fill(0)`.
   */
  wipeKeyCache?(): void;
}

// ─── KeychainKeyProvider ───────────────────────────────────────────────────

const KEYCHAIN_FORMAT_VERSION_SUPPORTED = new Set<number>([1]);

interface KeychainBlob {
  format_version: number;
  /** base64-encoded 32-byte AES key */
  key: string;
  /** monotonic counter; bumps on every successful write (§A.3 step 10) */
  generation: number;
}

function parseKeychainBlob(raw: string): KeychainBlob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KeyProviderError(
      "E_KEYCHAIN_BLOB_INVALID",
      "Keychain master-key entry is not valid JSON. Run `kuzo credentials wipe --confirm` to start over.",
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new KeyProviderError(
      "E_KEYCHAIN_BLOB_INVALID",
      "Keychain master-key entry is not a JSON object.",
    );
  }
  const blob = parsed as Record<string, unknown>;
  if (
    typeof blob.format_version !== "number" ||
    !KEYCHAIN_FORMAT_VERSION_SUPPORTED.has(blob.format_version)
  ) {
    throw new KeyProviderError(
      "E_KEYCHAIN_BLOB_INVALID",
      `Keychain master-key entry has unsupported format_version ${String(blob.format_version)}.`,
    );
  }
  if (typeof blob.key !== "string" || typeof blob.generation !== "number") {
    throw new KeyProviderError(
      "E_KEYCHAIN_BLOB_INVALID",
      "Keychain master-key entry is missing the `key` or `generation` field.",
    );
  }
  if (!Number.isInteger(blob.generation) || blob.generation < 1) {
    throw new KeyProviderError(
      "E_KEYCHAIN_BLOB_INVALID",
      `Keychain master-key entry has invalid generation ${blob.generation}; must be a positive integer.`,
    );
  }
  return {
    format_version: blob.format_version,
    key: blob.key,
    generation: blob.generation,
  };
}

export interface KeychainKeyProviderOptions {
  /** Keychain service name (default: "kuzo-mcp"). */
  service?: string;
  /** Keychain account name (default: "master-key"). */
  account?: string;
}

export class KeychainKeyProvider implements KeyProvider {
  readonly id = "keychain";
  readonly kdfId = KDF_KEYCHAIN;

  private cachedKey: Buffer | undefined;
  private cachedGeneration: bigint | undefined;
  private readonly entry: Entry;

  constructor(opts: KeychainKeyProviderOptions = {}) {
    // Per spec §A.5 invariant: `Entry()` is documented inert in
    // `@napi-rs/keyring` 1.3.0 — it allocates struct fields only and performs
    // no Keychain Services / dbus calls until `setPassword` / `getPassword`.
    this.entry = new Entry(opts.service ?? "kuzo-mcp", opts.account ?? "master-key");
  }

  acquireKey(_headerKdfParams: Buffer): Buffer {
    if (this.cachedKey) return this.cachedKey;
    const raw = this.entry.getPassword();
    if (raw === null) {
      throw new KeyProviderError(
        "E_KEY_LOST",
        "No master key entry found in the OS keychain. If `credentials.enc` exists, run `kuzo credentials wipe --confirm` and re-provision. Otherwise run `kuzo credentials set <name>` to initialize a fresh store.",
      );
    }
    const blob = parseKeychainBlob(raw);
    const key = Buffer.from(blob.key, "base64");
    if (key.length !== 32) {
      throw new KeyProviderError(
        "E_KEY_INVALID",
        `Keychain master key is ${key.length} bytes; expected 32. Possible tamper — refusing to proceed.`,
      );
    }
    this.cachedKey = key;
    this.cachedGeneration = BigInt(blob.generation);
    return this.cachedKey;
  }

  getGeneration(): bigint | undefined {
    return this.cachedGeneration;
  }

  bumpGeneration(newGeneration: bigint): void {
    if (!this.cachedKey) {
      throw new KeyProviderError(
        "E_KEY_LOST",
        "bumpGeneration called before acquireKey/initializeKey — provider has no cached key.",
      );
    }
    if (newGeneration < 1n) {
      throw new KeyProviderError(
        "E_KEY_INVALID",
        `bumpGeneration: generation must be >= 1; got ${newGeneration}`,
      );
    }
    const blob: KeychainBlob = {
      format_version: 1,
      key: this.cachedKey.toString("base64"),
      generation: Number(newGeneration),
    };
    this.entry.setPassword(JSON.stringify(blob));
    this.cachedGeneration = newGeneration;
  }

  initializeKey(): { key: Buffer; kdfParams: Buffer } {
    const key = randomBytes(32);
    const blob: KeychainBlob = {
      format_version: 1,
      key: key.toString("base64"),
      generation: 1,
    };
    this.entry.setPassword(JSON.stringify(blob));
    this.cachedKey = key;
    this.cachedGeneration = 1n;
    return { key, kdfParams: Buffer.alloc(0) };
  }

  wipeKeyCache(): void {
    if (this.cachedKey) this.cachedKey.fill(0);
    this.cachedKey = undefined;
    this.cachedGeneration = undefined;
  }
}

// ─── PassphraseKeyProvider ─────────────────────────────────────────────────

const SCRYPT_PARAMS = {
  N: 2 ** 17,
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024,
} as const;

const SCRYPT_SALT_LEN = 16;

export class PassphraseKeyProvider implements KeyProvider {
  readonly id = "passphrase";
  readonly kdfId = KDF_SCRYPT;

  private cachedKey: Buffer | undefined;
  // Honest-zero-fill semantics: V8 string interning leaves the original
  // UTF-16 bytes resident until GC. Overwriting + dropping the reference is
  // best-effort; the real defense is the unconditional `process.env` scrub
  // in `server.ts` step 7 plus the dead-by-default field after consumption.
  private passphrase: string | undefined;

  constructor(
    passphrase: string,
    private readonly auditLogger?: AuditLogger,
  ) {
    if (passphrase.length === 0) {
      throw new KeyProviderError(
        "E_PASSPHRASE_EMPTY",
        "KUZO_PASSPHRASE is empty — refusing to derive an AES master key from an empty string.",
      );
    }
    this.passphrase = passphrase;
  }

  acquireKey(headerKdfParams: Buffer): Buffer {
    if (this.cachedKey) return this.cachedKey;
    if (this.passphrase === undefined) {
      throw new KeyProviderError(
        "E_PASSPHRASE_CONSUMED",
        "PassphraseKeyProvider passphrase has been consumed and the derived key was wiped. Restart the server with KUZO_PASSPHRASE set to re-derive.",
      );
    }
    if (headerKdfParams.length !== SCRYPT_SALT_LEN) {
      throw new KeyProviderError(
        "E_KEY_INVALID",
        `Expected ${SCRYPT_SALT_LEN}-byte salt in credentials.enc header; got ${headerKdfParams.length} bytes.`,
      );
    }
    const saltFingerprint = createHash("sha256")
      .update(headerKdfParams)
      .digest("hex")
      .slice(0, 16);
    this.cachedKey = scryptSync(this.passphrase, headerKdfParams, 32, SCRYPT_PARAMS);
    this.consumePassphrase();
    this.auditLogger?.log({
      plugin: "kuzo",
      action: "credential.passphrase_consumed",
      outcome: "allowed",
      details: {
        provider: "passphrase",
        salt_fingerprint: saltFingerprint,
        initialized: false,
      },
    });
    return this.cachedKey;
  }

  initializeKey(): { key: Buffer; kdfParams: Buffer } {
    if (this.cachedKey) {
      throw new KeyProviderError(
        "E_PASSPHRASE_CONSUMED",
        "PassphraseKeyProvider.initializeKey called after key was already derived — refusing to re-derive with a fresh salt and orphan the existing ciphertext.",
      );
    }
    if (this.passphrase === undefined) {
      throw new KeyProviderError(
        "E_PASSPHRASE_CONSUMED",
        "PassphraseKeyProvider passphrase has been consumed; restart the server to re-enter.",
      );
    }
    const salt = randomBytes(SCRYPT_SALT_LEN);
    const key = scryptSync(this.passphrase, salt, 32, SCRYPT_PARAMS);
    this.cachedKey = key;
    const saltFingerprint = createHash("sha256").update(salt).digest("hex").slice(0, 16);
    this.consumePassphrase();
    this.auditLogger?.log({
      plugin: "kuzo",
      action: "credential.passphrase_consumed",
      outcome: "allowed",
      details: {
        provider: "passphrase",
        salt_fingerprint: saltFingerprint,
        // Round-4 B12: discriminates first-time provisioning from ongoing unlock.
        initialized: true,
      },
    });
    return { key, kdfParams: salt };
  }

  wipeKeyCache(): void {
    if (this.cachedKey) this.cachedKey.fill(0);
    this.cachedKey = undefined;
  }

  private consumePassphrase(): void {
    // V8 strings are immutable — this reassignment doesn't overwrite the
    // underlying UTF-16 bytes. Dropping the reference is the real defense.
    if (this.passphrase) this.passphrase = "\0".repeat(this.passphrase.length);
    this.passphrase = undefined;
  }
}

// ─── NullKeyProvider ───────────────────────────────────────────────────────

/**
 * Env-override-only sentinel. Selected when `KUZO_DISABLE_KEYCHAIN=1` is set
 * AND `KUZO_PASSPHRASE` is unset. Refuses every storage operation — the
 * store's file-not-found short-circuit fires in this mode, so a real
 * `acquireKey()` call is a programming error.
 */
export class NullKeyProvider implements KeyProvider {
  readonly id = "null";
  // Sentinel kdfId that will never match a real file header; chosen so an
  // accidental serialize() would fail validation immediately.
  readonly kdfId = KDF_KEYCHAIN; // never reached — never encrypts

  acquireKey(_headerKdfParams: Buffer): never {
    throw new KeyProviderError(
      "E_NO_STORAGE",
      "Credential storage is disabled (KUZO_DISABLE_KEYCHAIN=1 without KUZO_PASSPHRASE). Provide per-credential env overrides instead, or unset KUZO_DISABLE_KEYCHAIN to use the keychain.",
    );
  }

  initializeKey(): never {
    throw new KeyProviderError(
      "E_NO_STORAGE",
      "Credential storage is disabled (KUZO_DISABLE_KEYCHAIN=1 without KUZO_PASSPHRASE). Cannot initialize an encrypted store in env-override-only mode.",
    );
  }
}

// InMemoryKeyProvider has moved to `./testing.ts` and is published via the
// `@kuzo-mcp/core/credentials/testing` subpath, NOT the main credentials
// barrel — keeps the test double out of the production public surface so a
// future loader bug in Theme 4's `chooseKeyProvider()` can't accidentally
// reach for it (round 1 Security advisory).
