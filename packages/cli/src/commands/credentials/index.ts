/**
 * Commander subcommand tree for `kuzo credentials ...` (spec §B.1).
 *
 *   set <name>      — store/update a credential (interactive or --stdin)
 *   rotate <name>   — set + emit credential.rotated
 *   list            — names + backend + last-updated (--json)
 *   delete <name>   — remove a credential
 *   migrate         — import from ~/.claude/settings.json + .env, redact sources
 *   status          — backend + per-plugin availability (--json)
 *   test <name>     — verify the credential is accepted by its service
 *   wipe --confirm  — destroy ALL credentials + the master key (§A.11 recovery)
 *
 * Secrets never appear as a positional arg or flag value (§B.2): `set`/`rotate`
 * take only `<name>`, never `<value>`.
 */

import { Command } from "commander";
import chalk from "chalk";

import { runDelete, type CredentialsDeleteOptions } from "./delete.js";
import { exitCodeForCredentialsError } from "./errors.js";
import { runList, type CredentialsListOptions } from "./list.js";
import { runMigrate, type CredentialsMigrateOptions } from "./migrate.js";
import { runSet, type CredentialsSetOptions } from "./set.js";
import { runStatus, type CredentialsStatusOptions } from "./status.js";
import { runTest } from "./test.js";
import { runWipe, type CredentialsWipeOptions } from "./wipe.js";

export function registerCredentialsCommands(program: Command): void {
  const creds = program
    .command("credentials")
    .description("🔐 Manage stored credentials (encrypted at rest)");

  creds
    .command("set")
    .description("Set or update a credential (interactive prompt by default)")
    .argument("<name>", "Credential name (env-var-style, e.g. GITHUB_TOKEN)")
    .option("--stdin", "Read the value from stdin (single line, trimmed)", false)
    .option("-y, --yes", "Skip the overwrite confirmation", false)
    .action((name: string, options: CredentialsSetOptions) =>
      run(() => runSet(name, options, "set")),
    );

  creds
    .command("rotate")
    .description("Replace a credential's value (emits credential.rotated)")
    .argument("<name>", "Credential name to rotate")
    .option("--stdin", "Read the value from stdin (single line, trimmed)", false)
    .option("-y, --yes", "Skip the overwrite confirmation", false)
    .action((name: string, options: CredentialsSetOptions) =>
      run(() => runSet(name, options, "rotate")),
    );

  creds
    .command("list")
    .description("List credential names + backend + last-updated")
    .option("--json", "Emit JSON instead of a table")
    .action((options: CredentialsListOptions) => run(() => runList(options)));

  creds
    .command("delete")
    .description("Remove a credential")
    .argument("<name>", "Credential name to delete")
    .option("-y, --yes", "Skip the confirmation prompt", false)
    .action((name: string, options: CredentialsDeleteOptions) =>
      run(() => runDelete(name, options)),
    );

  creds
    .command("migrate")
    .description("Import credentials from ~/.claude/settings.json + .env files, then redact the sources")
    .option("--source <claude|env-file|both>", "Sources to scan", "both")
    .option("--dry-run", "Report candidates without modifying anything", false)
    .option("--force-source", "On a stored-vs-source conflict, overwrite the store (loud confirm)", false)
    .option("-y, --yes", "Skip the per-source confirmation (NOT the --force-source confirm)", false)
    .addHelpText(
      "after",
      `
Examples:
  Dry-run scan, show what would change:
    $ kuzo credentials migrate --dry-run

  Only scan ~/.claude/settings.json (skip project .env files):
    $ kuzo credentials migrate --source claude

  Re-run after a previous partial failure (idempotent):
    $ kuzo credentials migrate

  Resolve a conflict by overwriting the stored value:
    $ kuzo credentials migrate --force-source

Exit codes:
   0  success
  60  read-back verification failed (encryption round-trip mismatch — file an issue)
  61  post-redact parser still finds the credential in the source file
  62  rollback of the encrypted store failed (check \`kuzo credentials list\` + audit log)
  63  mutually-exclusive flags (--force-source with --yes)
  74  source file is a symlink
  75  source path is not a regular file
  76  source file was modified during migration (close your editor and retry)
  77  source value differs from stored (use --force-source or set manually)
`,
    )
    .action((options: CredentialsMigrateOptions) => run(() => runMigrate(options)));

  creds
    .command("status")
    .description("Show key-provider backend, store file, and per-plugin availability")
    .option("--json", "Emit JSON instead of the human-readable report")
    .action((options: CredentialsStatusOptions) => run(() => runStatus(options)));

  creds
    .command("test")
    .description("Verify a stored credential is accepted by its plugin's service")
    .argument("<name>", "Credential name to test")
    .action((name: string) => run(() => runTest(name)));

  creds
    .command("wipe")
    .description("Destroy ALL stored credentials AND the master key (KEY_LOST / CORRUPTED recovery)")
    .option("--confirm", "Required: acknowledge that this destroys everything", false)
    .action((options: CredentialsWipeOptions) => run(() => runWipe(options)));
}

/** Run a handler, print a red ✗ on failure, and exit with the mapped code. */
async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const message = (err as Error).message || String(err);
    console.error(chalk.red(`\n✗ ${message}`));
    process.exit(exitCodeForCredentialsError(err));
  }
}
