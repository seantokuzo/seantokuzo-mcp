/**
 * Post-install UX (spec §B.3 + R40): offer to configure the plugin's
 * credentials inline, then nudge the user to wire kuzo into Claude Code.
 *
 * Both steps are best-effort — the plugin is already committed by the time we
 * run, so a credential-prompt failure must NOT fail the install.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import chalk from "chalk";

import { isCredentialCapability, type KuzoPluginV2 } from "@kuzo-mcp/types";

import { readSecret } from "../credentials/secret-input.js";
import { openSource } from "../credentials/store-access.js";

export interface PostInstallOptions {
  yes?: boolean;
  /** Commander negatable `--no-onboarding-hint` → false. Default true. */
  onboardingHint?: boolean;
}

/** Run the §B.3 inline credential prompt + the R40 onboarding hint. */
export async function runPostInstall(
  manifest: KuzoPluginV2,
  options: PostInstallOptions,
): Promise<void> {
  await offerCredentialSetup(manifest, options);
  maybePrintOnboardingHint(options);
}

async function offerCredentialSetup(
  manifest: KuzoPluginV2,
  options: PostInstallOptions,
): Promise<void> {
  const required = manifest.capabilities.filter(isCredentialCapability);
  const optional = (manifest.optionalCapabilities ?? []).filter(isCredentialCapability);
  if (required.length === 0 && optional.length === 0) return;

  const allEnvs = new Set([...required, ...optional].map((c) => c.env));
  const { source, store, audit } = openSource(allEnvs);

  // On a fresh install with no store file, source.get() returns undefined
  // without touching the keychain — so this check won't prompt prematurely.
  const isSatisfied = (env: string): boolean => {
    try {
      return source.get(env) !== undefined;
    } catch {
      return false;
    }
  };

  const unsatisfied = required.filter((c) => !isSatisfied(c.env));
  if (unsatisfied.length === 0) return;

  console.log(
    `\nThis plugin needs ${unsatisfied.length} credential${unsatisfied.length === 1 ? "" : "s"}:`,
  );
  for (const c of unsatisfied) {
    console.log(`  ${chalk.cyan(c.env)} — ${c.reason}`);
  }

  // Interactive configuration requires a real TTY and no --yes.
  if (options.yes || !process.stdin.isTTY) {
    console.log(
      chalk.gray(`Configure later with: kuzo credentials set ${unsatisfied[0]!.env}`),
    );
    return;
  }

  const inquirer = await import("inquirer");
  const { proceed } = await inquirer.default.prompt<{ proceed: boolean }>([
    { type: "confirm", name: "proceed", message: "Configure now?", default: true },
  ]);
  if (!proceed) {
    console.log(chalk.gray(`Configure later with: kuzo credentials set <NAME>`));
    return;
  }

  for (const c of unsatisfied) {
    try {
      const value = await readSecret({ stdin: false, name: c.env });
      store.set(c.env, value);
      audit.log({
        plugin: manifest.name,
        action: "credential.set",
        outcome: "allowed",
        details: { credentialKey: c.env, backend: store.backend, after: value.length },
      });
      console.log(chalk.green(`  ✓ ${c.env}`));
    } catch (err) {
      console.log(
        chalk.yellow(
          `  ⚠ Could not store ${c.env} (${(err as Error).message}). Set it later: kuzo credentials set ${c.env}`,
        ),
      );
    }
  }
}

export function maybePrintOnboardingHint(options: PostInstallOptions): void {
  if (options.onboardingHint === false) return;
  if (process.env.KUZO_NO_ONBOARDING_HINT === "1") return;
  if (claudeCodeAlreadyWired()) return;

  console.log(
    "\n" +
      chalk.yellow("⚠ To use this plugin with Claude Code, add the kuzo MCP server to your settings:") +
      "\n" +
      chalk.gray("  1. Open ~/.claude/settings.json\n") +
      chalk.gray("  2. In mcpServers, add:\n") +
      chalk.gray('       "kuzo": { "command": "kuzo", "args": ["serve"], "env": {} }\n') +
      chalk.gray("  3. Restart Claude Code\n\n") +
      chalk.gray("Already wired? Ignore this. To suppress: --no-onboarding-hint (or KUZO_NO_ONBOARDING_HINT=1)"),
  );
}

/** True if `~/.claude/settings.json` already points `mcpServers.kuzo` at kuzo. */
function claudeCodeAlreadyWired(): boolean {
  try {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    if (!existsSync(settingsPath)) return false;
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    const kuzo = parsed.mcpServers?.kuzo;
    if (!kuzo) return false;
    if (kuzo.command === "kuzo") return true;
    // Canonical pre-2.6 pattern: node … @kuzo-mcp/core/dist/server.js
    return (
      kuzo.command === "node" &&
      (kuzo.args ?? []).some((a) => a.includes("@kuzo-mcp/core") && a.endsWith("server.js"))
    );
  } catch {
    return false;
  }
}
