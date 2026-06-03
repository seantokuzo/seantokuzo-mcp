/**
 * `kuzo serve` — Phase 2.6 §D.1 (stdio) + Phase 4a §4.2 (`--http`). Boots the
 * Kuzo MCP server. By default it serves over stdio by delegating to
 * `runServer()` in `@kuzo-mcp/core`; with `--http` it serves Streamable HTTP via
 * the OPT-IN `@kuzo-mcp/server-http` package (dynamic-imported, so the stdio CLI
 * carries zero HTTP/OAuth weight). Because credentials live in the encrypted
 * store, the canonical `~/.claude/settings.json` block is secret-free (§D.2):
 * `{ "command": "kuzo", "args": ["serve"], "env": {} }`.
 *
 * Both transports dynamic-import their server module so the rest of the CLI
 * (`kuzo credentials list`, etc.) never pays the server module graph's startup
 * cost (§D.5).
 */

import { Command } from "commander";

import { CRED_EXIT } from "./credentials/errors.js";

interface ServeOptions {
  /** `--no-scrub` → false (default true). */
  scrub: boolean;
  /** `--http` → serve Streamable HTTP instead of stdio. */
  http?: boolean;
  /** `--port <n>` (string from commander; parsed for `--http`). */
  port: string;
  /** `--host <host>` (used with `--http`). */
  host: string;
  /** `--no-auth` → false (default true). 4a HTTP requires `--no-auth`. */
  auth: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** KUZO_DEV gate — accept the handoff's `=1` and the repo's `=true` convention. */
function isDevMode(): boolean {
  const v = process.env["KUZO_DEV"];
  return v === "1" || v === "true";
}

function refuse(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(CRED_EXIT.E_SERVER_BOOT_FAILED);
}

function isModuleNotFound(err: unknown, specifier: string): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND" &&
    err.message.includes(specifier)
  );
}

/**
 * Phase 4a §4.2 HTTP path. 4a ships only `--no-auth` on a loopback host
 * (the OAuth Resource Server lands in 4b). The gate mirrors the `--no-scrub`
 * enforcement above: refuse to boot an unauthenticated server unless KUZO_DEV
 * is set, and never off loopback.
 */
async function serveOverHttp(options: ServeOptions): Promise<void> {
  if (options.auth) {
    refuse(
      "kuzo serve --http: OAuth is not available until Phase 4b.\n" +
        "For local dev, run unauthenticated on loopback: KUZO_DEV=1 kuzo serve --http --no-auth",
    );
  }
  if (!isDevMode()) {
    refuse(
      "kuzo serve --http --no-auth is debug-only and requires KUZO_DEV=1 (or KUZO_DEV=true).\n" +
        "Refusing to start an unauthenticated HTTP server.",
    );
  }
  if (!LOOPBACK_HOSTS.has(options.host)) {
    refuse(
      `kuzo serve --http --no-auth refuses a non-loopback --host ("${options.host}").\n` +
        "Unauthenticated HTTP is loopback-only — use 127.0.0.1 (auth + remote exposure arrive in 4b).",
    );
  }
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    refuse(`kuzo serve --http: invalid --port "${options.port}" (expected an integer 1–65535).`);
  }

  // Opt-in package — dynamic import. Distinguish "package not installed" from
  // "package present but broken" (§4.2): only print the install hint for a
  // genuine ERR_MODULE_NOT_FOUND on our specifier; rethrow everything else
  // (ERR_PACKAGE_PATH_NOT_EXPORTED, native-module errors) so a half-broken
  // install is never masked as "not installed".
  let serverHttp: typeof import("@kuzo-mcp/server-http");
  try {
    serverHttp = await import("@kuzo-mcp/server-http");
  } catch (err) {
    if (isModuleNotFound(err, "@kuzo-mcp/server-http")) {
      refuse(
        "kuzo serve --http needs the optional @kuzo-mcp/server-http package:\n" +
          "  npm i -g @kuzo-mcp/server-http",
      );
    }
    throw err;
  }

  try {
    await serverHttp.serveHttp({ scrub: options.scrub, port, host: options.host, noAuth: true });
  } catch (err) {
    refuse(`kuzo serve --http failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const serveCommand = new Command("serve")
  .description("Run the kuzo MCP server (stdio by default, or --http for Streamable HTTP)")
  .option(
    "--no-scrub",
    "Skip process.env scrubbing (debug only — requires KUZO_DEV=1; plugin children would inherit credential env vars)",
  )
  .option("--http", "Serve over Streamable HTTP via @kuzo-mcp/server-http instead of stdio")
  .option("--port <port>", "HTTP port (with --http)", "3000")
  .option("--host <host>", "HTTP bind host (with --http)", "127.0.0.1")
  .option(
    "--no-auth",
    "Disable OAuth (with --http; debug only — requires KUZO_DEV=1 and a loopback host)",
  )
  .action(async (options: ServeOptions) => {
    // --no-scrub gate (applies to both transports). Theme 4 round-2 deferral +
    // §D.5: disabling the scrub lets every plugin child inherit credential env
    // vars, so it must never be reachable from a stray flag in a non-interactive
    // settings.json launch. Gate it behind KUZO_DEV and refuse to boot otherwise.
    if (!options.scrub && !isDevMode()) {
      refuse(
        "kuzo serve: --no-scrub is debug-only and requires KUZO_DEV=1 (or KUZO_DEV=true).\n" +
          "Refusing to start with credential scrubbing disabled.",
      );
    }
    if (!options.scrub) {
      process.stderr.write("WARNING: scrub disabled\n");
    }

    if (options.http) {
      await serveOverHttp(options);
      return;
    }

    // Default: stdio transport (unchanged §D.1 path).
    const { runServer } = await import("@kuzo-mcp/core/server");
    try {
      await runServer({ scrub: options.scrub });
    } catch (err) {
      process.stderr.write(
        `kuzo serve failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(CRED_EXIT.E_SERVER_BOOT_FAILED);
    }
  });
