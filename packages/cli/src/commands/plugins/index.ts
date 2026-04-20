/**
 * Commander subcommand tree for `kuzo plugins ...`.
 *
 * D.1 ships only `install`. Subsequent parts wire uninstall/list/update/etc.
 */

import { Command } from "commander";
import chalk from "chalk";

import {
  exitCodeForError,
  runInstall,
  type InstallOptions,
} from "./install.js";

export function registerPluginsCommands(program: Command): void {
  const plugins = program
    .command("plugins")
    .description("🔌 Install and manage Kuzo plugins");

  plugins
    .command("install")
    .description("Install and verify a plugin from npm")
    .argument("<name>", "Plugin name (e.g. 'github') or npm package")
    .option("--version <version>", "Specific version (default: latest)")
    .option("--registry <url>", "Custom npm registry (default: npmjs.org)")
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
      "Override the npmjs.org-only registry gate",
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
}
