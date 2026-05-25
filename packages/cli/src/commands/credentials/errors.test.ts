/**
 * errors.test.ts — Phase 2.6 §B.10 — credentials exit-code table + mapper.
 *
 * Acceptance (§B.10): every code has a stable number and the mapper translates
 * the core store / key-provider / lock errors into the right §A.11 exit.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CredentialStoreError, KeyProviderError } from "@kuzo-mcp/core/credentials";

import { LockBusyError, LockCrossVersionError } from "../../lock.js";
import { CRED_EXIT, CredentialsCliError, exitCodeForCredentialsError } from "./errors.js";

test("CRED_EXIT: the §B.10 codes have their documented numbers", () => {
  assert.equal(CRED_EXIT.E_LOCK_CONTENTION, 30);
  assert.equal(CRED_EXIT.E_WIPE_CANCELLED, 64);
  assert.equal(CRED_EXIT.E_NO_INPUT_MODE, 65);
  assert.equal(CRED_EXIT.E_EMPTY_VALUE, 66);
  assert.equal(CRED_EXIT.E_INVALID_VALUE, 66);
  assert.equal(CRED_EXIT.E_NO_KEY_PROVIDER, 71);
  assert.equal(CRED_EXIT.E_KEY_LOST, 72);
  assert.equal(CRED_EXIT.E_FILE_CORRUPTED, 73);
  assert.equal(CRED_EXIT.E_CRED_INVALID, 78);
  assert.equal(CRED_EXIT.E_TEST_UNAVAILABLE, 79);
});

test("mapper: CredentialsCliError carries its own exit code", () => {
  assert.equal(exitCodeForCredentialsError(new CredentialsCliError("E_NO_INPUT_MODE", "x")), 65);
  assert.equal(exitCodeForCredentialsError(new CredentialsCliError("E_WIPE_CANCELLED", "x")), 64);
  assert.equal(exitCodeForCredentialsError(new CredentialsCliError("E_TEST_UNAVAILABLE", "x")), 79);
});

test("mapper: store errors map to the §A.11 state-machine exits", () => {
  assert.equal(exitCodeForCredentialsError(new CredentialStoreError("E_KEY_LOST", "x")), 72);
  assert.equal(exitCodeForCredentialsError(new CredentialStoreError("E_FILE_CORRUPTED", "x")), 73);
});

test("mapper: key-provider errors map by code", () => {
  assert.equal(exitCodeForCredentialsError(new KeyProviderError("E_KEY_LOST", "x")), 72);
  assert.equal(exitCodeForCredentialsError(new KeyProviderError("E_NO_STORAGE", "x")), 71);
  assert.equal(exitCodeForCredentialsError(new KeyProviderError("E_PASSPHRASE_EMPTY", "x")), 71);
  assert.equal(exitCodeForCredentialsError(new KeyProviderError("E_KEY_INVALID", "x")), 73);
  assert.equal(exitCodeForCredentialsError(new KeyProviderError("E_KEYCHAIN_BLOB_INVALID", "x")), 73);
});

test("mapper: lock errors map to 30, unknown errors to 1", () => {
  assert.equal(exitCodeForCredentialsError(new LockBusyError("/tmp/.lock")), 30);
  assert.equal(exitCodeForCredentialsError(new LockCrossVersionError("x")), 30);
  assert.equal(exitCodeForCredentialsError(new Error("nope")), 1);
});
