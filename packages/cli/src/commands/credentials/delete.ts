/**
 * `kuzo credentials delete <name>` (spec §B.1). Acquires the shared lock, since
 * it rewrites the encrypted store. Confirms unless `--yes`.
 */

import chalk from "chalk";

import { acquireKuzoLock } from "../../lock.js";
import { openStore, translateStoreError } from "./store-access.js";

export interface CredentialsDeleteOptions {
  yes: boolean;
}

export async function runDelete(
  name: string,
  options: CredentialsDeleteOptions,
): Promise<void> {
  const lock = await acquireKuzoLock("delete");
  try {
    const { store, audit } = openStore();

    if (!options.yes) {
      let exists: boolean;
      try {
        exists = store.get(name) !== undefined;
      } catch (err) {
        translateStoreError(err);
      }
      if (!exists) {
        console.log(chalk.gray(`${name} is not set — nothing to delete.`));
        return;
      }
      const confirmed = await confirmDelete(name);
      if (!confirmed) {
        console.log(chalk.gray("Aborted — credential unchanged."));
        return;
      }
    }

    let removed: boolean;
    try {
      removed = store.delete(name);
    } catch (err) {
      translateStoreError(err);
    }

    if (!removed) {
      console.log(chalk.gray(`${name} is not set — nothing to delete.`));
      return;
    }

    audit.log({
      plugin: "kuzo",
      action: "credential.deleted",
      outcome: "allowed",
      details: { credentialKey: name, backend: store.backend },
    });
    console.log(chalk.green(`✓ Deleted ${name}`));
  } finally {
    await lock.release();
  }
}

async function confirmDelete(name: string): Promise<boolean> {
  const inquirer = await import("inquirer");
  const { ok } = await inquirer.default.prompt<{ ok: boolean }>([
    { type: "confirm", name: "ok", message: `Delete ${name}?`, default: false },
  ]);
  return ok;
}
