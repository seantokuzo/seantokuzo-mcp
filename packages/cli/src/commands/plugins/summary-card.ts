/**
 * Shared UI primitives for plugin commands.
 *
 * `confirm` wraps inquirer with the same y/N defaults install/uninstall use.
 * `printSummaryCard` renders the install/update preview box. Capability
 * helpers format individual capabilities for the consent prompt.
 */

import boxen from "boxen";
import chalk from "chalk";

import type { VerifiedAttestation } from "@kuzo-mcp/core/provenance";
import type { Capability, KuzoPluginV2 } from "@kuzo-mcp/types";

export async function confirm(message: string): Promise<boolean> {
  const inquirer = await import("inquirer");
  const { ok } = await inquirer.default.prompt<{ ok: boolean }>([
    { type: "confirm", name: "ok", message, default: false },
  ]);
  return ok;
}

export interface SummaryCardOptions {
  /** Title shown on the box (e.g. "kuzo plugins install"). */
  title: string;
  /** When true, replaces the verification line with the `--trust-unsigned` warning. */
  trustUnsigned?: boolean;
}

export function printSummaryCard(
  friendlyName: string,
  pkg: string,
  verification: VerifiedAttestation,
  options: SummaryCardOptions,
): void {
  const firstParty = verification.firstParty
    ? chalk.green("✓ first-party")
    : chalk.yellow("third-party");
  const verified = options.trustUnsigned
    ? chalk.red.bold("✗ UNSIGNED (--trust-unsigned)")
    : chalk.green(`✓ ${verification.attestationsCount} attestations verified`);

  const lines = [
    `${chalk.bold("Plugin:")}        ${friendlyName}`,
    `${chalk.bold("Package:")}       ${pkg}`,
    `${chalk.bold("Version:")}       ${verification.package.version}`,
    `${chalk.bold("Source:")}        ${firstParty}`,
    `${chalk.bold("Verification:")}  ${verified}`,
  ];
  if (verification.repo) {
    lines.push(`${chalk.bold("Repo:")}          ${verification.repo}`);
  }
  if (verification.builder) {
    lines.push(`${chalk.bold("Builder:")}       ${verification.builder}`);
  }

  console.log(
    "\n" +
      boxen(lines.join("\n"), {
        padding: 1,
        borderColor: "cyan",
        title: options.title,
        titleAlignment: "left",
      }),
  );
}

export function printCapabilitySummary(plugin: KuzoPluginV2): void {
  console.log(
    "\n" + chalk.bold(`Plugin ${plugin.name}@${plugin.version} requests:`),
  );
  if (plugin.capabilities.length > 0) {
    console.log(chalk.bold("\n  Required capabilities:"));
    for (const cap of plugin.capabilities) {
      console.log("    " + formatCapabilityShort(cap));
    }
  }
  if (plugin.optionalCapabilities && plugin.optionalCapabilities.length > 0) {
    console.log(chalk.bold("\n  Optional capabilities:"));
    for (const cap of plugin.optionalCapabilities) {
      console.log("    " + formatCapabilityShort(cap));
    }
  }
  console.log();
}

/**
 * Render an add/remove diff of capabilities. Used by both `update` and
 * `rollback` to surface what's changing before re-prompting for consent.
 *
 * Pass an empty `removed` array to render a "fresh consent" view (only
 * additions shown) — used when the user has no prior consent record.
 */
export function printCapabilityDiff(
  plugin: KuzoPluginV2,
  added: Capability[],
  removed: Capability[],
  context: string,
): void {
  console.log(
    "\n" +
      chalk.bold(
        `${context} for ${plugin.name}@${plugin.version}:`,
      ),
  );
  if (added.length === 0 && removed.length === 0) {
    console.log(chalk.gray("  (no changes)"));
    return;
  }
  for (const cap of added) {
    console.log("  " + chalk.green("+ ") + formatCapabilityShort(cap));
  }
  for (const cap of removed) {
    console.log("  " + chalk.red("- ") + formatCapabilityShort(cap));
  }
  console.log();
}

export function formatCapabilityShort(cap: Capability): string {
  const tag = chalk.cyan(`[${cap.kind}]`);
  switch (cap.kind) {
    case "credentials":
      return `${tag} ${cap.env} (${cap.access})  — ${chalk.gray(cap.reason)}`;
    case "network":
      return `${tag} ${cap.domain}  — ${chalk.gray(cap.reason)}`;
    case "filesystem":
      return `${tag} ${cap.path} (${cap.access})  — ${chalk.gray(cap.reason)}`;
    case "cross-plugin":
      return `${tag} ${cap.target}  — ${chalk.gray(cap.reason)}`;
    case "system":
      return `${tag} ${cap.operation}${cap.command ? `:${cap.command}` : ""}  — ${chalk.gray(cap.reason)}`;
  }
}
