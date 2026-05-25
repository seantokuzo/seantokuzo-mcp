/**
 * `kuzo credentials status` (spec §B.5). Key-provider backend, store file info,
 * and per-plugin credential availability.
 *
 * Read-only: no lock. It DOES attempt one decrypt to enumerate stored names —
 * that's what produces the "✓ set (store)" rows in the spec's human example.
 * When decryption isn't possible (NullKeyProvider, KEY_LOST, CORRUPTED) it
 * degrades gracefully: `credentialCount` is null and store-backed creds show as
 * unconfirmed rather than crashing.
 */

import { statSync } from "node:fs";

import chalk from "chalk";

import { credentialsFilePath, kuzoHome } from "@kuzo-mcp/core/paths";

import { readIndex } from "../plugins/state.js";
import { openSource } from "./store-access.js";
import { allKnownEnvNames, knownPluginEnvs } from "./targets.js";

export interface CredentialsStatusOptions {
  json?: boolean;
}

export async function runStatus(options: CredentialsStatusOptions): Promise<void> {
  const declared = allKnownEnvNames();
  const { store, keyProvider, envOverrides } = openSource(declared);

  const filePath = credentialsFilePath();
  const stat = tryStat(filePath);

  // Best-effort decrypt to enumerate stored names. Null when storage is
  // disabled or the store is in a KEY_LOST / CORRUPTED state.
  let storedNames: Set<string> | null = null;
  try {
    storedNames = new Set(store.list());
  } catch {
    storedNames = null;
  }

  const versions = versionByPackage();
  const plugins = knownPluginEnvs().map((group) => {
    const shadowedByEnv: string[] = [];
    const available: string[] = [];
    const missing: string[] = [];
    for (const env of group.envs) {
      if (env in envOverrides) {
        shadowedByEnv.push(env);
        available.push(env);
      } else if (storedNames?.has(env)) {
        available.push(env);
      } else {
        missing.push(env);
      }
    }
    return {
      name: group.display,
      version: versions.get(group.packageName) ?? "",
      missing,
      shadowedByEnv,
      available,
    };
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          kuzoHome: kuzoHome(),
          keyProvider: { id: keyProvider.id, ready: keyProvider.id !== "null" },
          store: {
            path: filePath,
            exists: stat !== undefined,
            credentialCount: storedNames ? storedNames.size : null,
          },
          plugins,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(chalk.bold("Backend"));
  console.log(`  Key provider:   ${keyProvider.id}`);
  console.log(
    `  Store file:     ${filePath}` +
      (stat
        ? chalk.gray(`  (size ${stat.size} B, modified ${stat.mtime.toISOString()})`)
        : chalk.gray("  (not created yet)")),
  );
  if (storedNames === null && stat) {
    console.log(chalk.yellow("  ⚠ store present but could not be read (locked, disabled, or corrupted)"));
  }

  console.log(chalk.bold("\nPlugins"));
  for (const p of plugins) {
    if (p.missing.length === 0) {
      console.log(`  ${chalk.green("✓")} ${p.name}`);
    } else {
      console.log(
        `  ${chalk.red("✗")} ${p.name} ${chalk.red(`missing: ${p.missing.join(", ")}`)}`,
      );
    }
  }

  const envShadowed = plugins.flatMap((p) => p.shadowedByEnv);
  if (envShadowed.length > 0) {
    console.log(chalk.bold("\nEnvironment overrides active"));
    for (const name of envShadowed) {
      console.log(`  ${name} ${chalk.gray("(value redacted)")}`);
    }
  }
}

function tryStat(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/** Map packageName → installed version from the plugins index (empty in dev). */
function versionByPackage(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    for (const entry of Object.values(readIndex().plugins)) {
      map.set(entry.packageName, entry.currentVersion);
    }
  } catch {
    /* no index yet */
  }
  return map;
}
