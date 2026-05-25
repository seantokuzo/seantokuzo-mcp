/**
 * `kuzo plugins uninstall <name>` — remove a plugin (spec §D.1).
 *
 * Default flow:
 *   1. Resolve <name> against index.json (friendly name, then packageName)
 *   2. Acquire ~/.kuzo/plugins/.lock
 *   3. rm -rf ~/.kuzo/plugins/<friendlyName>/
 *   4. Delete entry from index.json
 *   5. consentStore.revokeConsent(<friendlyName>)
 *   6. Audit plugin.uninstalled
 *   7. Print "remove from kuzo.config.ts + restart" reminder
 *
 * With --keep-versions: skip step 3 so retained version dirs stay on disk
 * for future re-register, but still detach from the index and revoke consent.
 */

import { existsSync, rmSync } from "node:fs";

import boxen from "boxen";
import chalk from "chalk";

import { FileBackedAuditLogger, type AuditLogger } from "@kuzo-mcp/core/audit";
import { ConsentStore } from "@kuzo-mcp/core/consent";
import {
  readEnvNamespaceRegistry,
  removePluginEnvNames,
  writeEnvNamespaceRegistry,
} from "@kuzo-mcp/core/credentials";

import {
  acquireKuzoLock,
  LockBusyError,
  LockCrossVersionError,
} from "../../lock.js";
import { pluginDir } from "./paths.js";
import { readIndex, writeIndex, type PluginIndexEntry } from "./state.js";

export interface UninstallOptions {
  keepVersions?: boolean;
  yes?: boolean;
}

export async function runUninstall(
  nameArg: string,
  options: UninstallOptions,
): Promise<void> {
  const audit = new FileBackedAuditLogger();
  const index = readIndex();

  const resolved = resolveInstalled(index.plugins, nameArg);
  if (!resolved) {
    throw new UninstallError(
      "E_NOT_INSTALLED",
      notInstalledMessage(nameArg, Object.keys(index.plugins)),
    );
  }
  const { friendlyName, entry } = resolved;

  if (!options.yes) {
    const confirmed = await confirm(
      `Uninstall ${friendlyName}@${entry.currentVersion}${
        options.keepVersions ? " (keeping version dirs)" : ""
      }?`,
    );
    if (!confirmed) {
      console.log(chalk.gray("Aborted by user."));
      return;
    }
  }

  // Let the lock errors bubble to the Commander action so
  // exitCodeForUninstallError can map them.
  const lock = await acquireKuzoLock("uninstall");
  try {
    const removedVersions = options.keepVersions
      ? []
      : [...entry.retainedVersions];

    if (!options.keepVersions) {
      const dir = pluginDir(friendlyName);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    delete index.plugins[friendlyName];
    writeIndex(index);

    // §A.12.4 — release the plugin's env-name claim so the names become
    // reclaimable. Best-effort: a corrupt registry must not block uninstall.
    releaseEnvNamespace(friendlyName, entry.packageName, audit);

    const consentStore = new ConsentStore();
    const consentRevoked = consentStore.revokeConsent(friendlyName);

    audit.log({
      plugin: friendlyName,
      action: "plugin.uninstalled",
      outcome: "allowed",
      details: {
        version: entry.currentVersion,
        packageName: entry.packageName,
        keptVersions: options.keepVersions === true,
        removedVersions,
        consentRevoked,
      },
    });

    printSuccess(friendlyName, entry, options, removedVersions);
  } finally {
    await lock.release();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveInstalled(
  plugins: Record<string, PluginIndexEntry>,
  nameArg: string,
): { friendlyName: string; entry: PluginIndexEntry } | undefined {
  if (plugins[nameArg]) {
    return { friendlyName: nameArg, entry: plugins[nameArg] };
  }
  // Fall back to packageName lookup so `uninstall @kuzo-mcp/plugin-github`
  // works the same as `uninstall github`.
  for (const [name, entry] of Object.entries(plugins)) {
    if (entry.packageName === nameArg) {
      return { friendlyName: name, entry };
    }
  }
  return undefined;
}

/** §A.12.4 — drop the plugin's env-name claim from the local registry. */
function releaseEnvNamespace(
  friendlyName: string,
  packageName: string,
  audit: AuditLogger,
): void {
  try {
    const registry = readEnvNamespaceRegistry();
    if (!(packageName in registry.plugins)) return;
    const removed = registry.plugins[packageName] ?? [];
    writeEnvNamespaceRegistry(removePluginEnvNames(registry, packageName));
    audit.log({
      plugin: friendlyName,
      action: "credential.namespace_validated",
      outcome: "allowed",
      details: { package: packageName, action: "uninstalled", envs_added: [], envs_removed: removed },
    });
  } catch {
    // Registry maintenance is best-effort — never block an uninstall.
  }
}

function notInstalledMessage(nameArg: string, installed: string[]): string {
  const head = `"${nameArg}" is not installed.`;
  if (installed.length === 0) {
    return `${head} No plugins are currently installed.`;
  }
  return `${head} Installed: ${installed.sort().join(", ")}`;
}

async function confirm(message: string): Promise<boolean> {
  const inquirer = await import("inquirer");
  const { ok } = await inquirer.default.prompt<{ ok: boolean }>([
    { type: "confirm", name: "ok", message, default: false },
  ]);
  return ok;
}

function printSuccess(
  friendlyName: string,
  entry: PluginIndexEntry,
  options: UninstallOptions,
  removedVersions: string[],
): void {
  const lines = [
    chalk.green.bold(`✓ Uninstalled ${friendlyName}`),
    "",
    chalk.gray(
      `Package:   ${entry.packageName}\n` +
        `Version:   ${entry.currentVersion}\n` +
        (options.keepVersions
          ? `Kept ${String(entry.retainedVersions.length)} version dir(s) on disk (--keep-versions)\n`
          : removedVersions.length > 0
            ? `Removed:   ${removedVersions.join(", ")}\n`
            : "") +
        `\nNext step: remove "${friendlyName}": { enabled: true } from kuzo.config.ts,\n` +
        "then restart the MCP server.",
    ),
  ].join("\n");

  console.log("\n" + boxen(lines, { padding: 1, borderColor: "green" }));
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type UninstallErrorCode = "E_NOT_INSTALLED";

export class UninstallError extends Error {
  readonly code: UninstallErrorCode;
  readonly exitCode: number;
  constructor(code: UninstallErrorCode, message: string) {
    super(message);
    this.name = "UninstallError";
    this.code = code;
    this.exitCode = UNINSTALL_ERROR_EXIT_CODES[code];
  }
}

const UNINSTALL_ERROR_EXIT_CODES: Record<UninstallErrorCode, number> = {
  E_NOT_INSTALLED: 47,
};

export function exitCodeForUninstallError(err: unknown): number {
  if (err instanceof UninstallError) return err.exitCode;
  if (err instanceof LockBusyError || err instanceof LockCrossVersionError) return 30;
  return 1;
}
