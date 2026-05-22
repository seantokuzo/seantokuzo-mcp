/**
 * Test-only key provider — `InMemoryKeyProvider`.
 *
 * Lives in its own module (and is exported via the `./credentials/testing`
 * subpath, NOT the main `./credentials` barrel) so production code paths
 * cannot accidentally import it. The runtime `NODE_ENV` / `KUZO_TEST` guard
 * is still there as defense-in-depth — both env vars are user-controlled and
 * CI matrices routinely set `NODE_ENV=test`, so the public-surface separation
 * is the real defense once Theme 4 wires `chooseKeyProvider()`.
 *
 * Spec §A.5 enumerates exactly three production providers
 * (`KeychainKeyProvider`, `PassphraseKeyProvider`, `NullKeyProvider`); the
 * main barrel re-exports those three. This file is consumed only by tests.
 */

import { randomBytes } from "node:crypto";

import { KDF_KEYCHAIN } from "./cipher.js";
import { KeyProviderError } from "./errors.js";
import type { KeyProvider } from "./key-provider.js";

/**
 * Test double. Holds a pre-generated 32-byte key and an in-memory generation
 * counter. Guarded against accidental production use by checking
 * `NODE_ENV === "test"` or `KUZO_TEST === "1"` in the constructor; the
 * primary guard is the `./credentials/testing` subpath separation from
 * production providers.
 */
export class InMemoryKeyProvider implements KeyProvider {
  readonly id = "memory";
  readonly kdfId = KDF_KEYCHAIN;

  private cachedKey: Buffer | undefined;
  private cachedGeneration: bigint | undefined;
  /** Persisted across `initializeKey()` calls only when the caller pre-supplies
   *  a key — allows tests to assert against known plaintext. */
  private readonly seedKey: Buffer | undefined;

  constructor(opts: { key?: Buffer } = {}) {
    if (process.env.NODE_ENV !== "test" && process.env.KUZO_TEST !== "1") {
      throw new KeyProviderError(
        "E_TEST_ONLY",
        "InMemoryKeyProvider may only be constructed under NODE_ENV=test or KUZO_TEST=1. This is a test double — production code paths must select KeychainKeyProvider, PassphraseKeyProvider, or NullKeyProvider.",
      );
    }
    if (opts.key !== undefined) {
      if (opts.key.length !== 32) {
        throw new KeyProviderError(
          "E_KEY_INVALID",
          `InMemoryKeyProvider seed key must be 32 bytes; got ${opts.key.length}.`,
        );
      }
      this.seedKey = Buffer.from(opts.key);
    }
  }

  acquireKey(_headerKdfParams: Buffer): Buffer {
    if (this.cachedKey) return this.cachedKey;
    // No persistent backing store — refuse rather than silently initialize.
    // Tests should call `initializeKey()` first.
    throw new KeyProviderError(
      "E_KEY_LOST",
      "InMemoryKeyProvider.acquireKey called before initializeKey — no in-memory key set yet.",
    );
  }

  initializeKey(): { key: Buffer; kdfParams: Buffer } {
    const key = this.seedKey ? Buffer.from(this.seedKey) : randomBytes(32);
    this.cachedKey = key;
    this.cachedGeneration = 1n;
    return { key, kdfParams: Buffer.alloc(0) };
  }

  getGeneration(): bigint | undefined {
    return this.cachedGeneration;
  }

  bumpGeneration(newGeneration: bigint): void {
    if (!this.cachedKey) {
      throw new KeyProviderError(
        "E_KEY_LOST",
        "InMemoryKeyProvider.bumpGeneration called before initializeKey.",
      );
    }
    if (newGeneration < 1n) {
      throw new KeyProviderError(
        "E_KEY_INVALID",
        `bumpGeneration: generation must be >= 1; got ${newGeneration}`,
      );
    }
    this.cachedGeneration = newGeneration;
  }

  wipeKeyCache(): void {
    if (this.cachedKey) this.cachedKey.fill(0);
    this.cachedKey = undefined;
    this.cachedGeneration = undefined;
  }
}
