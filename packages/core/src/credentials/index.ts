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

export {
  InMemoryKeyProvider,
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
