/**
 * `kuzo credentials wipe --confirm` (spec §A.11). Destroys ALL credentials AND
 * the master key. The recovery path for the KEY_LOST (exit 72) and CORRUPTED
 * (exit 73) states, so it MUST work when only one of {master key, file} exists
 * and MUST NOT gate on `acquireKey()` — the credential count is best-effort.
 *
 * Requires the literal `--confirm` flag (no `-y/--yes` shorthand) PLUS an
 * interactive `yes` (literal, case-sensitive). Anything else aborts (exit 64).
 */

import { existsSync, unlinkSync } from "node:fs";

import chalk from "chalk";

import { credentialsFilePath } from "@kuzo-mcp/core/paths";

import { acquireKuzoLock } from "../../lock.js";
import { CredentialsCliError } from "./errors.js";
import { openStore } from "./store-access.js";

export interface CredentialsWipeOptions {
  confirm?: boolean;
}

export async function runWipe(options: CredentialsWipeOptions): Promise<void> {
  if (!options.confirm) {
    throw new CredentialsCliError(
      "E_WIPE_CANCELLED",
      "Refusing to wipe without the literal --confirm flag. " +
        "Run `kuzo credentials wipe --confirm` (there is no -y/--yes shorthand).",
    );
  }

  const lock = await acquireKuzoLock("wipe");
  try {
    const filePath = credentialsFilePath();
    const generationPath = `${filePath}.generation`;
    const fileExisted = existsSync(filePath);

    const { store, keyProvider, audit } = openStore();

    // Best-effort count WITHOUT gating on the key (§A.11): in KEY_LOST /
    // CORRUPTED this throws and we proceed with an unknown count.
    let credentialCount: number | null = null;
    if (fileExisted) {
      try {
        credentialCount = store.list().length;
      } catch {
        credentialCount = null;
      } finally {
        try {
          store.close();
        } catch {
          /* dropping the key cache is best-effort */
        }
      }
    }

    printWarning(filePath, fileExisted, credentialCount);

    if (!(await readYesConfirmation())) {
      throw new CredentialsCliError(
        "E_WIPE_CANCELLED",
        "Wipe cancelled — nothing was destroyed.",
      );
    }

    // Destroy: keychain master-key entry, the encrypted file, and the
    // passphrase-mode generation sidecar. Each step is independent so a
    // partial state still gets fully cleaned.
    const keychainEntryExisted = keyProvider.deleteMasterKey?.() ?? false;
    if (fileExisted) safeUnlink(filePath);
    if (existsSync(generationPath)) safeUnlink(generationPath);

    audit.log({
      plugin: "kuzo",
      action: "credential.wiped",
      outcome: "allowed",
      details: {
        file_existed: fileExisted,
        keychain_entry_existed: keychainEntryExisted,
        credential_count: credentialCount,
      },
    });

    console.log(
      chalk.green("✓ Wiped all stored credentials and the master key.") +
        chalk.gray("\nThe next `kuzo credentials set <NAME>` starts a fresh store."),
    );
  } finally {
    await lock.release();
  }
}

function printWarning(
  filePath: string,
  fileExisted: boolean,
  credentialCount: number | null,
): void {
  const countLine =
    credentialCount === null
      ? fileExisted
        ? chalk.yellow("  credentials could not be enumerated (store locked or corrupted)")
        : "  no credential file present"
      : `  ${credentialCount} credential${credentialCount === 1 ? "" : "s"} stored`;

  console.log(
    chalk.red.bold("This will destroy ALL stored credentials:") +
      "\n" +
      chalk.red("  - delete the master key in the keychain (service: kuzo-mcp, account: master-key)") +
      "\n" +
      chalk.red(`  - delete the encrypted credential file at ${filePath}`) +
      "\n\n" +
      countLine +
      "\n",
  );
}

async function readYesConfirmation(): Promise<boolean> {
  const inquirer = await import("inquirer");
  const { answer } = await inquirer.default.prompt<{ answer: string }>([
    { type: "input", name: "answer", message: "Type 'yes' to confirm:" },
  ]);
  return answer === "yes";
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone or unreadable — wipe is best-effort cleanup */
  }
}
