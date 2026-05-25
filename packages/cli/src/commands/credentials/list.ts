/**
 * `kuzo credentials list` (spec §B.5). Names + backend + last-updated. The
 * store tracks a single file-level write time (not per-credential), so the
 * "LAST UPDATED" column is the credentials file's mtime — every row shares it.
 * Read-only: no lock. Decrypts to enumerate names (one keychain prompt).
 */

import { statSync } from "node:fs";

import chalk from "chalk";

import { credentialsFilePath } from "@kuzo-mcp/core/paths";

import { openStore, translateStoreError } from "./store-access.js";

export interface CredentialsListOptions {
  json?: boolean;
}

export async function runList(options: CredentialsListOptions): Promise<void> {
  const { store } = openStore();
  let names: string[];
  try {
    names = store.list().sort();
  } catch (err) {
    translateStoreError(err);
  }

  const lastUpdated = fileMtimeISO();

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          backend: store.backend,
          storeFile: credentialsFilePath(),
          credentials: names.map((name) => ({ name, lastUpdated })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (names.length === 0) {
    console.log(chalk.gray("No credentials stored. Add one with: kuzo credentials set <NAME>"));
    return;
  }

  const human = lastUpdated ? fmtLocal(new Date(lastUpdated)) : "—";
  const nameWidth = Math.max(4, ...names.map((n) => n.length));
  const backendWidth = Math.max(7, store.backend.length);
  console.log(
    chalk.bold(
      `${"NAME".padEnd(nameWidth)}  ${"BACKEND".padEnd(backendWidth)}  LAST UPDATED`,
    ),
  );
  for (const name of names) {
    console.log(`${name.padEnd(nameWidth)}  ${store.backend.padEnd(backendWidth)}  ${human}`);
  }
}

function fileMtimeISO(): string | undefined {
  try {
    return statSync(credentialsFilePath()).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function fmtLocal(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
