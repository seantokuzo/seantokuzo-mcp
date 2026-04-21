/**
 * Commander subcommand tree for `kuzo plugins ...`.
 *
 * D.1 shipped `install`. D.2 adds `list`, `uninstall`, and `refresh-trust-root`.
 * D.3 will add `update`, `rollback`, `verify`.
 */

import { Command } from "commander";
import chalk from "chalk";

import {
  exitCodeForError,
  runInstall,
  type InstallOptions,
} from "./install.js";
import { runList, type ListOptions } from "./list.js";
import {
  exitCodeForRefreshTrustRootError,
  runRefreshTrustRoot,
} from "./refresh-trust-root.js";
import {
  exitCodeForUninstallError,
  runUninstall,
  type UninstallOptions,
} from "./uninstall.js";

export function registerPluginsCommands(program: Command): void {
  const plugins = program
    .command("plugins")
    .description("🔌 Install and manage Kuzo plugins");

  plugins
    .command("install")
    .description("Install and verify a plugin from npm")
    .argument("<name>", "Plugin name (e.g. 'github') or npm package")
    .option("--version <version>", "Specific version (default: latest)")
    .option(
      "--registry <url>",
      "Custom npm registry. Non-npmjs.org URLs are rejected unless --allow-registry is also passed.",
    )
    .option(
      "--trust-unsigned",
      "Skip provenance verification — supply-chain risk, use with care",
    )
    .option(
      "--allow-third-party",
      "Allow plugins from orgs outside the first-party list",
    )
    .option(
      "--allow-builder <url>",
      "Additional builder ID prefix to trust (repeatable)",
      (value: string, prev: string[] = []) => [...prev, value],
      [] as string[],
    )
    .option(
      "--allow-registry <url>",
      "Gate override that permits --registry to target a non-npmjs.org URL",
    )
    .option(
      "--dry-run",
      "Verify and print the install plan without writing to disk",
    )
    .option("-y, --yes", "Skip all confirmation prompts")
    .action(async (name: string, options: InstallOptions) => {
      try {
        await runInstall(name, options);
      } catch (err) {
        const message = (err as Error).message || String(err);
        console.error(chalk.red(`\n✗ ${message}`));
        process.exit(exitCodeForError(err));
      }
    });

  plugins
    .command("list")
    .description("List installed plugins")
    .option("--json", "Emit the installed-plugins registry as JSON")
    .action((options: ListOptions) => {
      try {
        runList(options);
      } catch (err) {
        const message = (err as Error).message || String(err);
        console.error(chalk.red(`\n✗ ${message}`));
        process.exit(1);
      }
    });

  plugins
    .command("uninstall")
    .description("Remove an installed plugin")
    .argument("<name>", "Plugin name (friendly name or npm package)")
    .option(
      "--keep-versions",
      "Leave retained version dirs on disk for later re-register",
    )
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (name: string, options: UninstallOptions) => {
      try {
        await runUninstall(name, options);
      } catch (err) {
        const message = (err as Error).message || String(err);
        console.error(chalk.red(`\n✗ ${message}`));
        process.exit(exitCodeForUninstallError(err));
      }
    });

  plugins
    .command("refresh-trust-root")
    .description(
      "Clear the Sigstore TUF + attestations caches so next install re-fetches",
    )
    .action(() => {
      try {
        runRefreshTrustRoot();
      } catch (err) {
        const message = (err as Error).message || String(err);
        console.error(chalk.red(`\n✗ ${message}`));
        process.exit(exitCodeForRefreshTrustRootError(err));
      }
    });
}
