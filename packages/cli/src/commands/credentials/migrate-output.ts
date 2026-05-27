/**
 * Presentation + interactive prompts for `kuzo credentials migrate`.
 *
 * Split out of the orchestrator (`migrate.ts`) so that module stays focused on
 * the classify → import → redact flow. Type-only imports from `migrate.js` are
 * erased at runtime, so there is no import cycle.
 */

import chalk from "chalk";

import type { MigrateSource } from "./migrate-discovery.js";
import type { NamePlan, RewriteFailure } from "./migrate.js";

export function printDryRun(sources: MigrateSource[], log: (line: string) => void): void {
  log(chalk.bold("This migration would (dry-run — maximum candidate set, no equality check):"));
  for (const source of sources) {
    log(chalk.cyan(`  ${source.path}`));
    for (const name of source.entries.keys()) {
      log(`    ${name}  ${chalk.gray("(would import + redact)")}`);
    }
  }
  log(chalk.gray("\nAn actual run skips values already stored identically. Re-run without --dry-run to apply."));
}

export function printPlan(
  plans: NamePlan[],
  sources: MigrateSource[],
  log: (line: string) => void,
): void {
  const imports = plans.filter((p) => p.action === "import");
  const forces = plans.filter((p) => p.action === "force-import");
  log(chalk.bold("This migration will:"));
  if (imports.length > 0) {
    log(`  IMPORT ${imports.length} credential(s) into the keychain-encrypted store:`);
    for (const p of imports) log(`    ${p.name}`);
  }
  if (forces.length > 0) {
    log(chalk.yellow(`  OVERWRITE ${forces.length} stored credential(s) with the source value (--force-source):`));
    for (const p of forces) log(`    ${p.name}`);
  }
  log(`  REWRITE ${sources.length} source file(s) (the keys above are removed from each):`);
  for (const source of sources) log(`    ${source.path}`);
}

export function printPartialSuccess(
  plans: NamePlan[],
  sources: MigrateSource[],
  failures: RewriteFailure[],
  log: (line: string) => void,
): void {
  const failedPaths = new Set(failures.map((f) => f.path));
  const redacted = sources.filter((s) => !failedPaths.has(s.path)).map((s) => s.path);
  log(chalk.yellow("\nMigration partially succeeded."));
  log(chalk.green(`  ✓ Imported into store: ${plans.map((p) => p.name).join(", ") || "(none)"}`));
  if (redacted.length > 0) log(chalk.green(`  ✓ Redacted from: ${redacted.join(", ")}`));
  for (const f of failures) log(chalk.red(`  ✗ Could NOT redact: ${f.path} (${f.code})`));
  log(
    chalk.gray(
      "\nTo finish, open each listed file and delete the credential keys from the kuzo MCP `env` block " +
        "(or the matching `.env` lines), then re-run `kuzo credentials migrate` (re-run is safe — already-stored values are skipped).",
    ),
  );
  log(chalk.gray("Your credentials are stored securely; the listed source(s) still contain them as a fallback until you finish."));
}

export async function defaultConfirm(message: string): Promise<boolean> {
  const inquirer = await import("inquirer");
  const { ok } = await inquirer.default.prompt<{ ok: boolean }>([
    { type: "confirm", name: "ok", message, default: false },
  ]);
  return ok;
}

export async function defaultForceConfirm(name: string, sources: string): Promise<boolean> {
  const inquirer = await import("inquirer");
  const { answer } = await inquirer.default.prompt<{ answer: string }>([
    {
      type: "input",
      name: "answer",
      message:
        `You are about to OVERWRITE the stored value of ${name} with the cleartext from ${sources}. ` +
        `The current stored value will be irrecoverable. Type 'yes' to confirm:`,
    },
  ]);
  return answer.trim() === "yes";
}
