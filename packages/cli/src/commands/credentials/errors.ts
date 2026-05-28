/**
 * Credentials-domain exit codes — the one place to look them up (spec §B.10).
 *
 * Mirrors the consolidated table. Migrate-only codes (60–63, 74–77) are
 * reserved here so the enum is complete, but `kuzo credentials migrate` ships
 * in Theme 8 — only the symbols are referenced before then.
 */

import {
  CredentialStoreError,
  KeyProviderError,
} from "@kuzo-mcp/core/credentials";

import { LockBusyError, LockCrossVersionError } from "../../lock.js";

/** Symbol → numeric exit code (spec §B.10 consolidated table). */
export const CRED_EXIT = {
  OK: 0,
  E_LOCK_CONTENTION: 30,
  E_READBACK_FAIL: 60, // migrate (Theme 8)
  E_REDACTION_VERIFY_FAIL: 61, // migrate (Theme 8)
  E_ROLLBACK_FAIL: 62, // migrate (Theme 8)
  E_INVALID_FLAG_COMBO: 63, // migrate (Theme 8)
  E_WIPE_CANCELLED: 64,
  E_NO_INPUT_MODE: 65,
  E_EMPTY_VALUE: 66,
  E_INVALID_VALUE: 66,
  E_NO_KEY_PROVIDER: 71,
  E_KEY_LOST: 72,
  E_FILE_CORRUPTED: 73,
  E_SYMLINK_REFUSE: 74, // migrate (Theme 8)
  E_NOT_REGULAR_FILE: 75, // migrate (Theme 8)
  E_SOURCE_MUTATED: 76, // migrate (Theme 8)
  E_CONFLICT: 77, // migrate (Theme 8)
  E_CRED_INVALID: 78,
  E_TEST_UNAVAILABLE: 79,
  E_SERVER_BOOT_FAILED: 80, // kuzo serve (Theme 9) — moved from 70 per R44
} as const;

export type CredentialsErrorCode = keyof typeof CRED_EXIT;

/** A credentials-command failure that carries its own exit code. */
export class CredentialsCliError extends Error {
  override name = "CredentialsCliError" as const;
  readonly code: CredentialsErrorCode;
  readonly exitCode: number;
  constructor(code: CredentialsErrorCode, message: string) {
    super(message);
    this.code = code;
    this.exitCode = CRED_EXIT[code];
  }
}

/**
 * Map any error thrown by a `kuzo credentials` handler to a process exit code.
 * Translates the core store / key-provider error codes into the §A.11 state-
 * machine exits (KEY_LOST → 72, CORRUPTED → 73) and the shared lock errors
 * into 30.
 */
export function exitCodeForCredentialsError(err: unknown): number {
  if (err instanceof CredentialsCliError) return err.exitCode;
  if (err instanceof LockBusyError || err instanceof LockCrossVersionError) {
    return CRED_EXIT.E_LOCK_CONTENTION;
  }
  if (err instanceof CredentialStoreError) {
    if (err.code === "E_KEY_LOST") return CRED_EXIT.E_KEY_LOST;
    if (err.code === "E_FILE_CORRUPTED") return CRED_EXIT.E_FILE_CORRUPTED;
    return 1; // E_INTERNAL
  }
  if (err instanceof KeyProviderError) {
    switch (err.code) {
      case "E_KEY_LOST":
        return CRED_EXIT.E_KEY_LOST;
      case "E_NO_STORAGE":
      case "E_PASSPHRASE_EMPTY":
        return CRED_EXIT.E_NO_KEY_PROVIDER;
      case "E_KEY_INVALID":
      case "E_KEYCHAIN_BLOB_INVALID":
        return CRED_EXIT.E_FILE_CORRUPTED;
      default:
        return 1;
    }
  }
  return 1;
}
