/**
 * `kuzo serve` — Phase 2.6 §D.1. Boots the Kuzo MCP server (stdio transport)
 * by delegating to `runServer()` in `@kuzo-mcp/core`. Because credentials now
 * live in the encrypted store, the canonical `~/.claude/settings.json` block
 * is secret-free (§D.2): `{ "command": "kuzo", "args": ["serve"], "env": {} }`.
 *
 * `runServer` is dynamic-imported so the rest of the CLI (`kuzo credentials
 * list`, etc.) never pays the server module graph's startup cost (§D.5).
 */

import { Command } from "commander";

import { CRED_EXIT } from "./credentials/errors.js";

/** KUZO_DEV gate — accept the handoff's `=1` and the repo's `=true` convention. */
function isDevMode(): boolean {
  const v = process.env["KUZO_DEV"];
  return v === "1" || v === "true";
}

export const serveCommand = new Command("serve")
  .description("Run the kuzo MCP server (stdio transport)")
  .option(
    "--no-scrub",
    "Skip process.env scrubbing (debug only — requires KUZO_DEV=1; plugin children would inherit credential env vars)",
  )
  .action(async (options: { scrub: boolean }) => {
    // Commander negated flag: `--no-scrub` sets `options.scrub === false`
    // (default true). Theme 4 round-2 deferral + §D.5: disabling the scrub
    // lets every plugin child inherit credential env vars, so it must never
    // be reachable from a stray flag in a non-interactive settings.json
    // launch. Gate it behind KUZO_DEV and refuse to boot otherwise.
    if (!options.scrub && !isDevMode()) {
      process.stderr.write(
        "kuzo serve: --no-scrub is debug-only and requires KUZO_DEV=1 (or KUZO_DEV=true).\n" +
          "Refusing to start with credential scrubbing disabled.\n",
      );
      process.exit(CRED_EXIT.E_SERVER_BOOT_FAILED);
    }
    if (!options.scrub) {
      process.stderr.write("WARNING: scrub disabled\n");
    }

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
