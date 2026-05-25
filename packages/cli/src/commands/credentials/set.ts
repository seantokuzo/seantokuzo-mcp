/**
 * `kuzo credentials set <name>` and its `rotate` alias (spec §B.1, §B.2, §A.11).
 *
 * The secret is read via the {@link readSecret} contract — never a positional
 * arg or flag value. The §A.11 state machine is enforced by the store + key
 * provider: a write against an existing file with a missing keychain key throws
 * `E_KEY_LOST` (→ exit 72) and a failed decrypt throws `E_FILE_CORRUPTED`
 * (→ exit 73); we never silently re-init and orphan the existing ciphertext.
 */

import chalk from "chalk";

import { acquireKuzoLock } from "../../lock.js";
import { readSecret } from "./secret-input.js";
import { openStore, translateStoreError } from "./store-access.js";

export interface CredentialsSetOptions {
  stdin: boolean;
  yes: boolean;
}

/** `mode` selects the audit action + messaging: plain set vs. rotation. */
export async function runSet(
  name: string,
  options: CredentialsSetOptions,
  mode: "set" | "rotate" = "set",
): Promise<void> {
  // Read the secret BEFORE taking the lock so a cancelled prompt doesn't hold
  // the lock, and so a bad-input error surfaces without disk contention.
  const value = await readSecret({ stdin: options.stdin, name });

  const lock = await acquireKuzoLock(mode);
  try {
    const { store, audit } = openStore();

    // Surface the §A.11 KEY_LOST / CORRUPTED states early via a read; on a
    // fresh store (no file) this returns undefined without touching the key.
    let existing: string | undefined;
    try {
      existing = store.get(name);
    } catch (err) {
      translateStoreError(err);
    }

    if (existing !== undefined && !options.yes) {
      const overwrite = await confirmOverwrite(name);
      if (!overwrite) {
        console.log(chalk.gray("Aborted — credential unchanged."));
        return;
      }
    }

    try {
      store.set(name, value);
    } catch (err) {
      translateStoreError(err);
    }

    audit.log({
      plugin: "kuzo",
      action: mode === "rotate" ? "credential.rotated" : "credential.set",
      outcome: "allowed",
      details:
        mode === "rotate" && existing !== undefined
          ? { credentialKey: name, backend: store.backend, before: existing.length, after: value.length }
          : { credentialKey: name, backend: store.backend, after: value.length },
    });

    const verb = mode === "rotate" ? "Rotated" : existing !== undefined ? "Updated" : "Stored";
    console.log(chalk.green(`✓ ${verb} ${name}`) + chalk.gray(` (backend: ${store.backend})`));
    if (mode !== "rotate") {
      console.log(chalk.gray(`To rotate later: kuzo credentials rotate ${name}`));
    }
  } finally {
    await lock.release();
  }
}

async function confirmOverwrite(name: string): Promise<boolean> {
  const inquirer = await import("inquirer");
  const { ok } = await inquirer.default.prompt<{ ok: boolean }>([
    {
      type: "confirm",
      name: "ok",
      message: `${name} is already set. Overwrite?`,
      default: false,
    },
  ]);
  return ok;
}
