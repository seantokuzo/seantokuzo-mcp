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
  /** `--no-auth` → false (default true). The default mounts the OAuth Resource Server. */
  auth: boolean;
  /** `--auth-issuer <url>` — OAuth Authorization Server issuer (or KUZO_OAUTH_ISSUER). */
  authIssuer?: string;
  /** `--auth-jwks-uri <url>` — AS JWKS endpoint (or KUZO_OAUTH_JWKS_URI). */
  authJwksUri?: string;
  /** `--auth-resource <url>` — canonical MCP resource URL / RFC 8707 audience (or KUZO_OAUTH_RESOURCE). */
  authResource?: string;
  /** `--auth-authorization-endpoint <url>` — re-advertised AS authorize endpoint (default `<issuer>/authorize`). */
  authAuthorizationEndpoint?: string;
  /** `--auth-token-endpoint <url>` — re-advertised AS token endpoint (default `<issuer>/token`). */
  authTokenEndpoint?: string;
  /** `--auth-registration-endpoint <url>` — AS DCR endpoint, advertised when set. */
  authRegistrationEndpoint?: string;
  /** `--auth-scopes <csv>` — scopes advertised in the AS/PR metadata. */
  authScopes?: string;
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

/** Split a comma-separated flag value into trimmed, non-empty parts. */
function parseCsv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

/**
 * Phase 4b §4.3 HTTP path. The default mounts the OAuth Resource Server — the
 * issuer / JWKS URL / canonical resource URL come from `--auth-*` flags or the
 * `KUZO_OAUTH_*` env vars and are resolved + validated inside `serveHttp`
 * (which throws a clear error naming any missing value before it decrypts the
 * store). `--no-auth` keeps the loopback-only dev path, gated behind KUZO_DEV
 * exactly like `--no-scrub`.
 */
async function serveOverHttp(options: ServeOptions): Promise<void> {
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    refuse(`kuzo serve --http: invalid --port "${options.port}" (expected an integer 1–65535).`);
  }

  if (!options.auth) {
    // --no-auth dev path: mirror the --no-scrub gate. KUZO_DEV + loopback only.
    if (!isDevMode()) {
      refuse(
        "kuzo serve --http --no-auth is debug-only and requires KUZO_DEV=1 (or KUZO_DEV=true).\n" +
          "Refusing to start an unauthenticated HTTP server.",
      );
    }
    if (!LOOPBACK_HOSTS.has(options.host)) {
      refuse(
        `kuzo serve --http --no-auth refuses a non-loopback --host ("${options.host}").\n` +
          "Unauthenticated HTTP is loopback-only — use 127.0.0.1.",
      );
    }
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

  // Default → OAuth Resource Server; --no-auth → loopback dev path. The auth
  // bundle is undefined under --no-auth (serveHttp ignores it then).
  const auth = options.auth
    ? {
        issuer: options.authIssuer,
        jwksUri: options.authJwksUri,
        resource: options.authResource,
        authorizationEndpoint: options.authAuthorizationEndpoint,
        tokenEndpoint: options.authTokenEndpoint,
        registrationEndpoint: options.authRegistrationEndpoint,
        scopes: parseCsv(options.authScopes),
      }
    : undefined;

  try {
    await serverHttp.serveHttp({
      scrub: options.scrub,
      port,
      host: options.host,
      noAuth: !options.auth,
      auth,
    });
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
    "Disable the OAuth Resource Server (with --http; debug only — requires KUZO_DEV=1 and a loopback host)",
  )
  .option("--auth-issuer <url>", "OAuth Authorization Server issuer (or KUZO_OAUTH_ISSUER)")
  .option("--auth-jwks-uri <url>", "AS JWKS endpoint for token signature verification (or KUZO_OAUTH_JWKS_URI)")
  .option("--auth-resource <url>", "Canonical MCP resource URL / RFC 8707 audience (or KUZO_OAUTH_RESOURCE)")
  .option("--auth-authorization-endpoint <url>", "Re-advertised AS authorize endpoint (default <issuer>/authorize)")
  .option("--auth-token-endpoint <url>", "Re-advertised AS token endpoint (default <issuer>/token)")
  .option("--auth-registration-endpoint <url>", "AS dynamic-client-registration endpoint, advertised when set")
  .option("--auth-scopes <csv>", "Comma-separated scopes advertised in the OAuth metadata")
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
