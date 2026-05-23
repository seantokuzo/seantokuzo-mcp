/**
 * key-provider-choice.ts — Phase 2.6 §C.2 / §A.5 — `KeyProvider` selection.
 *
 * Pure selection logic — no I/O. All three provider constructors are inert
 * (no keychain / dbus / scrypt at construction per §A.5 invariant); the
 * first external call happens in `acquireKey()` / `initializeKey()`, which
 * run AFTER the `process.env` scrub at boot step 7.
 *
 * Precedence (spec §A.5 lines 614–620):
 *   1. `KUZO_DISABLE_KEYCHAIN=1` + `KUZO_PASSPHRASE` set
 *      → `PassphraseKeyProvider` (passphrase mode on platforms with broken
 *        or missing keychain libs).
 *   2. `KUZO_DISABLE_KEYCHAIN=1` + `KUZO_PASSPHRASE` unset
 *      → `NullKeyProvider` (env-override-only mode, recommended for
 *        ephemeral CI with per-credential secret injection).
 *   3. `KUZO_PASSPHRASE` set (without `KUZO_DISABLE_KEYCHAIN`)
 *      → `PassphraseKeyProvider` (explicit passphrase opt-in even when the
 *        keychain is available).
 *   4. Otherwise
 *      → `KeychainKeyProvider`.
 *
 * There is no silent plain-env fallback — the only "env-only" path is the
 * explicit `KUZO_DISABLE_KEYCHAIN=1` opt-in, which yields a `NullKeyProvider`
 * that fails closed if anything tries to access the encrypted store.
 *
 * `PassphraseKeyProvider` captures the passphrase string into a private
 * field at construction; the unconditional `KUZO_PASSPHRASE` scrub in
 * `scrubProcessEnv` (step 7) lands AFTER this function returns, so it does
 * not race the capture.
 */

import type { AuditLogger } from "./audit.js";
import {
  KeychainKeyProvider,
  NullKeyProvider,
  PassphraseKeyProvider,
  type KeyProvider,
} from "./credentials/index.js";

export function chooseKeyProvider(auditLogger: AuditLogger): KeyProvider {
  if (process.env.KUZO_DISABLE_KEYCHAIN === "1") {
    if (process.env.KUZO_PASSPHRASE) {
      return new PassphraseKeyProvider(process.env.KUZO_PASSPHRASE, auditLogger);
    }
    return new NullKeyProvider();
  }
  if (process.env.KUZO_PASSPHRASE) {
    return new PassphraseKeyProvider(process.env.KUZO_PASSPHRASE, auditLogger);
  }
  return new KeychainKeyProvider();
}
