/**
 * Shared wiring for the `kuzo credentials` commands: build the audit logger +
 * key provider + encrypted store + credential source, and translate the core
 * store / key-provider errors into the §A.11 state-machine CLI errors.
 */

import { FileBackedAuditLogger, type AuditLogger } from "@kuzo-mcp/core/audit";
import {
  chooseKeyProvider,
  collectEnvOverrides,
  CredentialSource,
  CredentialStoreError,
  EncryptedCredentialStore,
  KeyProviderError,
  type CredentialStore,
  type KeyProvider,
} from "@kuzo-mcp/core/credentials";
import { credentialsFilePath } from "@kuzo-mcp/core/paths";

import { CredentialsCliError } from "./errors.js";

export interface StoreContext {
  store: CredentialStore;
  keyProvider: KeyProvider;
  audit: AuditLogger;
}

/**
 * Construct the audit logger, key provider, and encrypted store. All three
 * constructors are inert (no keychain / dbus / scrypt until the first
 * acquire/read), so this is safe to call before any prompt.
 */
export function openStore(): StoreContext {
  const audit = new FileBackedAuditLogger();
  const keyProvider = chooseKeyProvider(audit);
  const store = new EncryptedCredentialStore({
    filePath: credentialsFilePath(),
    keyProvider,
    auditLogger: audit,
  });
  return { store, keyProvider, audit };
}

export interface SourceContext extends StoreContext {
  source: CredentialSource;
  /** The resolved `process.env` overrides — keys reveal which creds are env-shadowed. */
  envOverrides: Record<string, string>;
}

/**
 * Build a {@link CredentialSource} over the store plus the `process.env`
 * overrides for `declaredEnvNames` (plain + `KUZO_TOKEN_<NAME>`). The CLI is a
 * fresh, un-scrubbed process, so env overrides reflect the user's shell / .env.
 */
export function openSource(declaredEnvNames: ReadonlySet<string>): SourceContext {
  const ctx = openStore();
  const envOverrides = collectEnvOverrides(declaredEnvNames);
  const source = new CredentialSource(ctx.store, envOverrides);
  return { ...ctx, source, envOverrides };
}

export function keyLostCliError(): CredentialsCliError {
  return new CredentialsCliError(
    "E_KEY_LOST",
    `The credential file at ${credentialsFilePath()} exists, but the master key entry in the keychain is missing. ` +
      `The file cannot be decrypted. Run \`kuzo credentials wipe --confirm\` to clear both and start over, ` +
      `OR restore the keychain entry (e.g., Time Machine keychain restore).`,
  );
}

export function corruptedCliError(): CredentialsCliError {
  return new CredentialsCliError(
    "E_FILE_CORRUPTED",
    `The credential file at ${credentialsFilePath()} failed AES-GCM verification. Either the file was tampered with ` +
      `OR the master key in the keychain does not match the one used to encrypt this file. ` +
      `Run \`kuzo credentials wipe --confirm\` to start over.`,
  );
}

/**
 * Re-throw a core store / key-provider error as the matching §A.11 state-machine
 * CLI error (KEY_LOST → exit 72, CORRUPTED → exit 73). Unrelated errors pass
 * through unchanged. Never returns.
 */
export function translateStoreError(err: unknown): never {
  if (err instanceof KeyProviderError) {
    if (err.code === "E_KEY_LOST") throw keyLostCliError();
    if (err.code === "E_KEY_INVALID" || err.code === "E_KEYCHAIN_BLOB_INVALID") {
      throw corruptedCliError();
    }
  }
  if (err instanceof CredentialStoreError && err.code === "E_FILE_CORRUPTED") {
    throw corruptedCliError();
  }
  throw err;
}
