/**
 * Error classes for the credentials subsystem (Phase 2.6 Part A).
 *
 * Two classes:
 *   - {@link KeyProviderError} — surfaces from anything in `key-provider.ts`
 *     (acquireKey / initializeKey / parseKeychainBlob / NullKeyProvider).
 *   - {@link CredentialStoreError} — surfaces from anything in `store.ts`
 *     (AES-GCM verify failure, generation-rollback, header tamper).
 *
 * Both carry a `.code` field that the CLI command layer maps to exit codes
 * (spec §B.10): 72 = `E_KEY_LOST`, 73 = `E_FILE_CORRUPTED`, etc. Those mappings
 * land with Theme 7 (`kuzo credentials *` commands). The code field is the
 * stable identifier — re-format the human-readable `.message` freely; never
 * the `.code`.
 */

export type KeyProviderErrorCode =
  | "E_KEY_LOST"
  | "E_KEY_INVALID"
  | "E_KEYCHAIN_BLOB_INVALID"
  | "E_PASSPHRASE_EMPTY"
  | "E_PASSPHRASE_CONSUMED"
  | "E_NO_STORAGE"
  | "E_TEST_ONLY";

export type CredentialStoreErrorCode =
  | "E_FILE_CORRUPTED"
  | "E_KEY_LOST"
  | "E_INTERNAL";

export class KeyProviderError extends Error {
  readonly code: KeyProviderErrorCode;
  constructor(code: KeyProviderErrorCode, message: string) {
    super(message);
    this.name = "KeyProviderError";
    this.code = code;
  }
}

export class CredentialStoreError extends Error {
  readonly code: CredentialStoreErrorCode;
  constructor(code: CredentialStoreErrorCode, message: string) {
    super(message);
    this.name = "CredentialStoreError";
    this.code = code;
  }
}
