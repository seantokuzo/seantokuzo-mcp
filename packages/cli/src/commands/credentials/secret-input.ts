/**
 * Secret-input contract (spec §B.2). One rule: the secret NEVER appears as a
 * positional arg or a flag value.
 *
 *   TTY, no --stdin      → Inquirer password prompt (echo-off).
 *   --stdin (any TTY)    → read one line from stdin; trim trailing newline.
 *   non-TTY, no --stdin  → refuse (E_NO_INPUT_MODE). No silent pipe reads.
 *
 * The value is rejected if empty, or if it contains a NUL byte or an embedded
 * newline (E_EMPTY_VALUE / E_INVALID_VALUE, both exit 66).
 */

import { CredentialsCliError } from "./errors.js";

export interface ReadSecretOptions {
  /** Whether `--stdin` was passed. */
  stdin: boolean;
  /** Credential name, shown in the interactive prompt. */
  name: string;
}

/** Resolve the secret value per the §B.2 mode table. */
export async function readSecret(opts: ReadSecretOptions): Promise<string> {
  if (opts.stdin) {
    return validateSecret(await readLineFromStdin());
  }
  // No --stdin: a TTY is required. Refuse to read a pipe the user didn't opt
  // into (§B.2) and refuse to echo a visible prompt when stdin isn't a TTY
  // (§B.8 — VSCode-style stdout-TTY-but-stdin-pipe terminals).
  if (!process.stdin.isTTY) {
    throw new CredentialsCliError(
      "E_NO_INPUT_MODE",
      "stdin is not a TTY and --stdin was not passed; refusing to silently read a pipe. " +
        "Run in an interactive terminal, or pass --stdin to read the value from a pipe.",
    );
  }
  return validateSecret(await promptPassword(opts.name));
}

/** Read up to the first newline (or EOF) from stdin; strip a trailing \r. */
async function readLineFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const all = Buffer.concat(chunks).toString("utf-8");
  const nl = all.search(/\r?\n/);
  return nl >= 0 ? all.slice(0, nl) : all;
}

/** Echo-off interactive prompt. No `mask` — a masked prompt leaks length. */
async function promptPassword(name: string): Promise<string> {
  const inquirer = await import("inquirer");
  const { value } = await inquirer.default.prompt<{ value: string }>([
    { type: "password", name: "value", message: `Value for ${name}:` },
  ]);
  return value;
}

function validateSecret(value: string): string {
  if (value.length === 0) {
    throw new CredentialsCliError(
      "E_EMPTY_VALUE",
      "Credential value is empty; refusing to store an empty secret.",
    );
  }
  if (value.includes("\0")) {
    throw new CredentialsCliError(
      "E_INVALID_VALUE",
      "Credential value contains a NUL byte; refusing to store it.",
    );
  }
  if (/[\r\n]/.test(value)) {
    throw new CredentialsCliError(
      "E_INVALID_VALUE",
      "Credential value contains an embedded newline; only a single line is allowed.",
    );
  }
  return value;
}
