/**
 * EncryptedCredentialStore — AES-256-GCM blob on disk + a generation counter
 * for rollback resistance (spec §A.4 + §A.3).
 *
 * Lazy-decrypts on first access. After `close()` the in-memory cache is wiped
 * and the next read re-decrypts. The file at `credentialsFilePath()` (default
 * `<kuzoHome>/credentials.enc`) is mode 0600 on POSIX.
 *
 * Generation source-of-truth lives in two places by mode:
 *   - keychain mode (`KdfId === KDF_KEYCHAIN`): inside the keychain blob, via
 *     `KeyProvider.getGeneration()` / `bumpGeneration()`.
 *   - scrypt/passphrase mode (`KdfId === KDF_SCRYPT`): in `<kuzoHome>/credentials.generation`,
 *     a 0600 file containing a base-10 ASCII integer. The store owns this file.
 *
 * Write path follows §A.3 step ordering: generation persists FIRST, then the
 * encrypted file is renamed into place. A crash between those two steps leaves
 * the user in CORRUPTED state (file_gen < live_gen → GCM verify fails). The
 * tradeoff is rollback-attack resistance; see §A.3 and §F.4.
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
import { dirname } from "node:path";

import type { AuditLogger } from "../audit.js";
import type { KuzoLogger } from "../logger.js";
import {
  decryptFile,
  encryptFile,
  KDF_KEYCHAIN,
  KDF_SCRYPT,
  type KdfId,
} from "./cipher.js";
import { CredentialStoreError, KeyProviderError } from "./errors.js";
import type { KeyProvider } from "./key-provider.js";

// ─── Plaintext payload ─────────────────────────────────────────────────────

/** JSON payload encoded inside the ciphertext (spec §A.3 plaintext payload). */
interface CredentialPayload {
  version: 1;
  credentials: Record<string, string>;
  createdAt: string;
  lastUpdated: string;
}

const PAYLOAD_VERSION = 1 as const;

function parsePayload(buf: Buffer): CredentialPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString("utf-8"));
  } catch {
    throw new CredentialStoreError(
      "E_FILE_CORRUPTED",
      "credentials.enc decrypted to non-JSON content — possible mid-write corruption.",
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new CredentialStoreError(
      "E_FILE_CORRUPTED",
      "credentials.enc decrypted to non-object JSON.",
    );
  }
  const p = parsed as Record<string, unknown>;
  if (p.version !== PAYLOAD_VERSION) {
    throw new CredentialStoreError(
      "E_FILE_CORRUPTED",
      `credentials.enc payload has unsupported version ${String(p.version)}; expected ${PAYLOAD_VERSION}.`,
    );
  }
  if (
    p.credentials === null ||
    typeof p.credentials !== "object" ||
    Array.isArray(p.credentials)
  ) {
    throw new CredentialStoreError(
      "E_FILE_CORRUPTED",
      "credentials.enc payload `credentials` field is not an object.",
    );
  }
  // Forward-compat per §A.3: tolerate unknown payload fields, treat missing
  // fields as defaults — only `version` + `credentials` are required today.
  const credsRaw = p.credentials as Record<string, unknown>;
  const credentials: Record<string, string> = {};
  for (const [k, v] of Object.entries(credsRaw)) {
    if (typeof v !== "string") {
      throw new CredentialStoreError(
        "E_FILE_CORRUPTED",
        `credentials.enc has non-string value for credential "${k}".`,
      );
    }
    credentials[k] = v;
  }
  return {
    version: PAYLOAD_VERSION,
    credentials,
    createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date(0).toISOString(),
    lastUpdated: typeof p.lastUpdated === "string" ? p.lastUpdated : new Date().toISOString(),
  };
}

// ─── CredentialStore interface ─────────────────────────────────────────────

export interface CredentialStore {
  /** Get a credential value (cleartext). Lazy-decrypts on first call. */
  get(key: string): string | undefined;
  /** Set a credential value. Persists immediately. */
  set(key: string, value: string): void;
  /** Delete a credential. Returns true if it was present. */
  delete(key: string): boolean;
  /** Names of currently-set credentials. */
  list(): string[];
  /** Whether a key is present in the in-memory cache. Returns false on a
   *  never-unlocked store; call `get()` first if you need definitive lookup. */
  has(key: string): boolean;
  /** True if the store has been decrypted at least once during this lifetime. */
  isUnlocked(): boolean;
  /** Number of credentials in the in-memory cache (0 before unlock, after close). */
  readonly size: number;
  /** Force a fresh re-decrypt from disk. */
  reload(): void;
  /** Zero the in-memory cleartext map and wipe the key provider's key cache. */
  close(): void;
  /** Backend identity for status output ("keychain" | "passphrase" | "memory" | "null"). */
  readonly backend: string;
}

// ─── EncryptedCredentialStore ──────────────────────────────────────────────

export interface EncryptedCredentialStoreOptions {
  /** Absolute path to credentials.enc (typically `credentialsFilePath()`). */
  filePath: string;
  /** Master-key provider — keychain / passphrase / null / memory (test). */
  keyProvider: KeyProvider;
  /** Optional structured audit logger; emits `credential.store_unlocked`/`_locked`. */
  auditLogger?: AuditLogger;
  /** Optional stderr logger. */
  logger?: KuzoLogger;
  /**
   * Override path for the passphrase-mode generation counter. Defaults to
   * `<filePath>.generation`. Theme 4's `chooseKeyProvider()` wiring may also
   * use this when pinning the counter to a specific `$KUZO_HOME` layout —
   * not test-only.
   */
  generationFilePath?: string;
}

export class EncryptedCredentialStore implements CredentialStore {
  readonly backend: string;

  private readonly filePath: string;
  private readonly generationFilePath: string;
  private readonly keyProvider: KeyProvider;
  private readonly auditLogger: AuditLogger | undefined;
  private readonly logger: KuzoLogger | undefined;

  /** Cleartext credentials map. `undefined` before first decrypt and after close. */
  private cache: Map<string, string> | undefined;
  /** Cached payload metadata so updates preserve `createdAt`. */
  private payloadMeta: { createdAt: string } | undefined;
  /** Cached header KDF params so `mutate()` doesn't re-read the file just to
   *  thread the salt back through `acquireKey()`. Set by `unlockFromDisk()`,
   *  cleared by `reload()` / `close()`. */
  private cachedKdfParams: Buffer | undefined;
  /**
   * Sticky flag — flipped on the FIRST `close()` call, never reset. Gates
   * the `credential.store_locked` audit emit so repeat-close scenarios
   * (signal-handler + finally idempotent teardowns) don't double-emit.
   * Spec §C.5 mandates an emit even on a never-unlocked close so forensics
   * can correlate "stopped without ever unlocking" — but the spec doesn't
   * mandate one PER call. Round-2 Security/Architecture advisory A1.
   *
   * **Lifecycle contract: lock-once-per-instance** (round-4 Security
   * advisory A1). The store can be re-unlocked from disk after a
   * `close()` via the lazy-decrypt path in `get()` (see the existing
   * "get() after close() re-decrypts" test). When the re-unlocked store
   * is then closed again, this flag stays set — the second close is
   * silent. Forensic consumers wanting to correlate multi-cycle
   * lifecycles should observe `credential.store_unlocked` (which DOES
   * fire on each unlock) rather than expecting a paired re-emit of
   * `store_locked`. This is by design: in normal operation each store
   * instance closes once at process exit, and the documented
   * "lock-once-per-instance" semantic is simpler to reason about than a
   * paired emit-per-cycle scheme.
   */
  private hasEmittedClose = false;

  constructor(options: EncryptedCredentialStoreOptions) {
    this.filePath = options.filePath;
    this.generationFilePath = options.generationFilePath ?? `${options.filePath}.generation`;
    this.keyProvider = options.keyProvider;
    this.auditLogger = options.auditLogger;
    this.logger = options.logger;
    this.backend = options.keyProvider.id;
  }

  // ─── Reads ──────────────────────────────────────────────────────────────

  get(key: string): string | undefined {
    if (this.cache === undefined) {
      if (!existsSync(this.filePath)) {
        // File-not-found short-circuit (spec §A.5 NullKeyProvider justification):
        // never invoke acquireKey() in env-override-only mode — the store
        // stays locked, the broker falls back to env overrides.
        return undefined;
      }
      this.unlockFromDisk();
    }
    return this.cache?.get(key);
  }

  has(key: string): boolean {
    if (this.cache === undefined) return false;
    return this.cache.has(key);
  }

  list(): string[] {
    if (this.cache === undefined) {
      if (!existsSync(this.filePath)) return [];
      this.unlockFromDisk();
    }
    return [...(this.cache?.keys() ?? [])];
  }

  isUnlocked(): boolean {
    return this.cache !== undefined;
  }

  get size(): number {
    return this.cache?.size ?? 0;
  }

  reload(): void {
    this.cache = undefined;
    this.payloadMeta = undefined;
    this.cachedKdfParams = undefined;
    if (!existsSync(this.filePath)) return;
    this.unlockFromDisk();
  }

  // ─── Writes ─────────────────────────────────────────────────────────────

  set(key: string, value: string): void {
    this.mutate((map) => {
      map.set(key, value);
    });
  }

  delete(key: string): boolean {
    // Definitive presence check requires the cache to be populated. `has()`
    // short-circuits on a never-unlocked store, so route through `get()`
    // which triggers the file-existence + decrypt path as needed.
    const existing = this.get(key);
    if (existing === undefined) return false;
    this.mutate((map) => {
      map.delete(key);
    });
    return true;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  close(): void {
    // Snapshot priorCount BEFORE any clearing so the audit reflects what
    // was actually decrypted in this process lifetime. 0 on a never-unlocked
    // store — still emitted so forensics can correlate "server stopped
    // without ever unlocking" against "server stopped with N creds live".
    const priorCount = this.cache?.size ?? 0;
    if (this.cache !== undefined) {
      // Best-effort cleanup; V8 strings can't be overwritten.
      for (const k of this.cache.keys()) this.cache.delete(k);
      this.cache = undefined;
      this.payloadMeta = undefined;
      this.cachedKdfParams = undefined;
    }
    // wipeKeyCache is the parent's real master-key wipe — call on every
    // close() so a malformed teardown path can't leave the key Buffer
    // populated. Cheap (Buffer.fill is a few cycles) and idempotent in
    // every KeyProvider implementation.
    this.keyProvider.wipeKeyCache?.();
    // Emit credential.store_locked ONCE per store instance. First close
    // (whether the store was unlocked or not) is the forensic signal;
    // subsequent close() calls are silent. Round-2 advisory A1.
    if (!this.hasEmittedClose) {
      this.hasEmittedClose = true;
      this.auditLogger?.log({
        plugin: "kuzo",
        action: "credential.store_locked",
        outcome: "allowed",
        details: { backend: this.backend, priorCount },
      });
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private unlockFromDisk(): void {
    const file = readFileSync(this.filePath);
    // Read the header's KDF params block so `acquireKey` (passphrase) gets
    // the salt. Keychain mode ignores its argument.
    const kdfParams = peekKdfParams(file);
    const key = this.keyProvider.acquireKey(kdfParams);
    const liveGen = this.readLiveGeneration();
    if (liveGen === undefined) {
      // File exists but no live generation counter — KEY_LOST state (keychain
      // mode) or generation file missing (passphrase mode). The keychain path
      // throws E_KEY_LOST from `acquireKey` so we never reach here for it; for
      // passphrase mode, missing .generation file is a corrupt half-state.
      throw new CredentialStoreError(
        "E_FILE_CORRUPTED",
        `credentials.enc exists but no live generation counter is available (looked for ${this.generationFilePath} or keychain blob field). Run \`kuzo credentials wipe --confirm\` to start over.`,
      );
    }
    const { plaintext } = decryptFile({ key, file, expectedGeneration: liveGen });
    const payload = parsePayload(plaintext);
    this.cache = new Map(Object.entries(payload.credentials));
    this.payloadMeta = { createdAt: payload.createdAt };
    this.cachedKdfParams = kdfParams;
    this.auditLogger?.log({
      plugin: "kuzo",
      action: "credential.store_unlocked",
      outcome: "allowed",
      details: { backend: this.backend, credentials: this.cache.size, generation: liveGen.toString() },
    });
  }

  private mutate(fn: (map: Map<string, string>) => void): void {
    const fileExists = existsSync(this.filePath);

    let key: Buffer;
    let kdfParams: Buffer;
    let nextGeneration: bigint;
    let baseMap: Map<string, string>;
    let payloadCreatedAt: string;
    const now = new Date().toISOString();

    if (!fileExists) {
      // Fresh state (no file). Try acquireKey first to handle Fresh-with-key
      // (keychain entry survived an out-of-band file deletion) — fall back to
      // initializeKey on E_KEY_LOST or E_KEY_INVALID (passphrase with no salt).
      const acquired = this.tryAcquireWithoutFile();
      if (acquired === "initialize") {
        const init = this.keyProvider.initializeKey();
        key = init.key;
        kdfParams = init.kdfParams;
        // initializeKey wrote `generation: 1` to the keychain blob (or will
        // be the first content of credentials.generation). Encrypt with gen=1
        // so file_gen matches live_gen; no further bump for the first write.
        nextGeneration = 1n;
      } else {
        key = acquired.key;
        kdfParams = acquired.kdfParams;
        // Fresh-with-key (keychain mode only — passphrase can't reach this
        // branch because acquireKey rejects empty-Buffer salt). The provider
        // has cached the keychain blob's gen alongside the key.
        const cachedGen = this.keyProvider.getGeneration?.();
        if (cachedGen === undefined) {
          throw new CredentialStoreError(
            "E_INTERNAL",
            "Fresh-with-key state: KeyProvider did not expose generation after successful acquireKey().",
          );
        }
        nextGeneration = cachedGen + 1n;
      }
      baseMap = new Map();
      payloadCreatedAt = now;
    } else {
      // File exists. Ensure cache + cached kdfParams are populated.
      if (this.cache === undefined || this.cachedKdfParams === undefined) {
        this.unlockFromDisk();
      }
      // unlockFromDisk has cached the provider's key + the header's kdfParams.
      // acquireKey is a cached no-op at this point.
      kdfParams = this.cachedKdfParams!;
      key = this.keyProvider.acquireKey(kdfParams);
      const liveGen = this.readLiveGeneration();
      if (liveGen === undefined) {
        throw new CredentialStoreError(
          "E_FILE_CORRUPTED",
          "No live generation counter available for an existing credentials.enc. Run `kuzo credentials wipe --confirm`.",
        );
      }
      nextGeneration = liveGen + 1n;
      baseMap = this.cache ?? new Map();
      payloadCreatedAt = this.payloadMeta?.createdAt ?? now;
    }

    const newMap = new Map(baseMap);
    fn(newMap);

    const payload: CredentialPayload = {
      version: PAYLOAD_VERSION,
      credentials: Object.fromEntries(newMap),
      createdAt: payloadCreatedAt,
      lastUpdated: now,
    };
    const plaintext = Buffer.from(JSON.stringify(payload), "utf-8");

    const ciphertext = encryptFile({
      key,
      kdfId: this.keyProvider.kdfId,
      kdfParams,
      generation: nextGeneration,
      plaintext,
    });

    // Generation-persists-first: bump live counter BEFORE renaming the file.
    // A crash between these two steps leaves user in CORRUPTED state; recovery
    // is `wipe --confirm + re-provision`. Tradeoff per spec §A.3 step 10.
    this.writeLiveGeneration(nextGeneration);
    this.writeFileAtomic(ciphertext);

    // Update in-memory cache to reflect the persisted state.
    this.cache = newMap;
    this.payloadMeta = { createdAt: payloadCreatedAt };
    this.cachedKdfParams = kdfParams;
  }

  /**
   * On a no-file path, decide whether to acquire (Fresh-with-key) or initialize
   * (true Fresh) the key. Returns an opaque sentinel for the initialize path.
   */
  private tryAcquireWithoutFile():
    | { key: Buffer; kdfParams: Buffer }
    | "initialize" {
    try {
      const key = this.keyProvider.acquireKey(Buffer.alloc(0));
      // For keychain mode, kdfParams is always empty Buffer. For scrypt this
      // branch is unreachable: passphrase `acquireKey(Buffer.alloc(0))` rejects
      // the zero-length salt with E_KEY_INVALID, which falls through to init.
      return { key, kdfParams: Buffer.alloc(0) };
    } catch (e) {
      if (e instanceof KeyProviderError) {
        if (e.code === "E_KEY_LOST" || e.code === "E_KEY_INVALID") {
          return "initialize";
        }
      }
      throw e;
    }
  }

  /** Read the live generation counter from the mode-appropriate source. */
  private readLiveGeneration(): bigint | undefined {
    if (this.keyProvider.kdfId === KDF_KEYCHAIN) {
      // After acquireKey, provider exposes the cached blob's generation.
      return this.keyProvider.getGeneration?.();
    }
    if (this.keyProvider.kdfId === KDF_SCRYPT) {
      if (!existsSync(this.generationFilePath)) return undefined;
      const raw = readFileSync(this.generationFilePath, "utf-8").trim();
      if (!/^\d+$/.test(raw)) {
        throw new CredentialStoreError(
          "E_FILE_CORRUPTED",
          `${this.generationFilePath} does not contain a base-10 integer; refusing to parse.`,
        );
      }
      const n = BigInt(raw);
      if (n < 1n) {
        throw new CredentialStoreError(
          "E_FILE_CORRUPTED",
          `${this.generationFilePath} contains generation ${raw}; must be >= 1.`,
        );
      }
      return n;
    }
    return undefined;
  }

  /** Atomically persist the new generation counter to its source-of-truth. */
  private writeLiveGeneration(newGeneration: bigint): void {
    switch (this.keyProvider.kdfId) {
      case KDF_KEYCHAIN: {
        if (!this.keyProvider.bumpGeneration) {
          throw new CredentialStoreError(
            "E_INTERNAL",
            "keychain-mode KeyProvider missing bumpGeneration capability",
          );
        }
        this.keyProvider.bumpGeneration(newGeneration);
        return;
      }
      case KDF_SCRYPT: {
        const tmp = `${this.generationFilePath}.tmp`;
        const fd = openSync(tmp, "w", 0o600);
        try {
          writeSync(fd, `${newGeneration.toString()}\n`);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, this.generationFilePath);
        return;
      }
    }
  }

  /** Atomic write: tmp + fsync + rename + chmod 0600. */
  private writeFileAtomic(ciphertext: Buffer): void {
    const tmp = `${this.filePath}.tmp`;
    // Ensure parent dir exists — defensive; the kuzoHome dir is created by
    // upstream callers (audit/consent constructors). If a third path opens the
    // store first, fail loud rather than silently dropping the file at $CWD.
    const parent = dirname(this.filePath);
    if (!existsSync(parent)) {
      throw new CredentialStoreError(
        "E_INTERNAL",
        `Cannot write credentials.enc: parent directory ${parent} does not exist`,
      );
    }
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, ciphertext);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, this.filePath);
      chmodSync(this.filePath, 0o600);
    } catch (err) {
      // Best-effort cleanup of the staged tmp file on rename failure so we
      // don't leak partial state into the dir.
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
    this.logger?.debug(`credentials.enc written at ${this.filePath}`);
  }
}

// ─── Local helpers ─────────────────────────────────────────────────────────

/** Read just enough of the file header to extract the KDF params block. */
function peekKdfParams(file: Buffer): Buffer {
  if (file.length < 6) {
    throw new CredentialStoreError(
      "E_FILE_CORRUPTED",
      `credentials.enc is shorter than the fixed header (${file.length} bytes)`,
    );
  }
  const kdfId = file.readUInt8(5);
  if (kdfId !== KDF_KEYCHAIN && kdfId !== KDF_SCRYPT) {
    throw new CredentialStoreError(
      "E_FILE_CORRUPTED",
      `Unknown KDF id 0x${kdfId.toString(16).padStart(2, "0")} in credentials.enc header`,
    );
  }
  const paramsLen = (kdfId as KdfId) === KDF_SCRYPT ? 16 : 0;
  if (file.length < 6 + paramsLen) {
    throw new CredentialStoreError(
      "E_FILE_CORRUPTED",
      `credentials.enc is shorter than its declared header (${file.length} < ${6 + paramsLen})`,
    );
  }
  return Buffer.from(file.subarray(6, 6 + paramsLen));
}
