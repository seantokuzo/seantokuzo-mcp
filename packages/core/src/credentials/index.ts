/**
 * Public surface of the credential storage subsystem (Phase 2.6 §A.1–A.4).
 *
 * Consumers re-export via `@kuzo-mcp/core/credentials`. Theme 3 (`CredentialSource`,
 * `collectEnvOverrides`) and Theme 4 (`runServer()` integration) build on top
 * of these primitives; tests live alongside the implementation in this dir.
 */

export {
  decryptFile,
  encryptFile,
  FORMAT_VERSION,
  KDF_KEYCHAIN,
  KDF_SCRYPT,
  MAGIC,
  type DecryptFileInput,
  type DecryptFileResult,
  type EncryptFileInput,
  type KdfId,
} from "./cipher.js";

export {
  CredentialStoreError,
  KeyProviderError,
  type CredentialStoreErrorCode,
  type KeyProviderErrorCode,
} from "./errors.js";

// NOTE: `InMemoryKeyProvider` is intentionally NOT re-exported here. The test
// double lives in `./testing.ts` and is published via the
// `@kuzo-mcp/core/credentials/testing` subpath. Spec §A.5 enumerates exactly
// three production providers; this barrel matches that exactly.
export {
  KeychainKeyProvider,
  NullKeyProvider,
  PassphraseKeyProvider,
  type KeyProvider,
  type KeychainKeyProviderOptions,
} from "./key-provider.js";

export {
  EncryptedCredentialStore,
  type CredentialStore,
  type EncryptedCredentialStoreOptions,
} from "./store.js";

// Phase 2.6 Theme 3 — env override + store merge, plus pure env-collection /
// scrub helpers. Theme 4 wires both into the boot sequence.
export { CredentialSource } from "./source.js";
export {
  collectEnvOverrides,
  scrubProcessEnv,
  type ScrubProcessEnvResult,
} from "./env-overrides.js";
