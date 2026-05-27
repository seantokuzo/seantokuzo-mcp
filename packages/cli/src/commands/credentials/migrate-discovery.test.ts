/**
 * migrate-discovery.test.ts — Phase 2.6 §B.4 source discovery (R22 bounded walk).
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { discoverSources, type MigrateSource } from "./migrate-discovery.js";

const KNOWN = new Set([
  "GITHUB_TOKEN",
  "GITHUB_USERNAME",
  "JIRA_HOST",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
]);

let base: string;
let home: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "kuzo-migrate-disc-"));
  home = join(base, "home");
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function mkdir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}
function write(p: string, content: string): void {
  writeFileSync(p, content);
}
function kuzoPkg(): string {
  return JSON.stringify({ dependencies: { "@kuzo-mcp/cli": "^0.1.0" } });
}
function byKind(sources: MigrateSource[], kind: string): MigrateSource[] {
  return sources.filter((s) => s.kind === kind);
}

test("claude: collects known creds from kuzo entries, ignores non-kuzo + unknown keys", () => {
  mkdir(join(home, ".claude"));
  write(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      mcpServers: {
        kuzo: {
          command: "kuzo",
          args: ["serve"],
          env: { GITHUB_TOKEN: "ghp_x", LOG_LEVEL: "debug", JIRA_HOST: "https://x" },
        },
        unrelated: { command: "other", env: { GITHUB_TOKEN: "not-ours" } },
      },
    }),
  );

  const sources = discoverSources({ source: "claude", knownEnvNames: KNOWN, home, cwd: home });
  const claude = byKind(sources, "claude");
  assert.equal(claude.length, 1);
  assert.deepEqual([...claude[0]!.entries.keys()].sort(), ["GITHUB_TOKEN", "JIRA_HOST"]);
  assert.equal(claude[0]!.entries.get("GITHUB_TOKEN"), "ghp_x");
  // No env-file scan under --source claude.
  assert.equal(byKind(sources, "env-file").length, 0);
});

test("env-file: bounded walk honors the package.json @kuzo-mcp gate + $HOME/.env", () => {
  // home/.env (always), home/proj/.env (gated, qualifies), home/proj/nogate/.env (no kuzo dep → skip)
  write(join(home, ".env"), "GITHUB_USERNAME=me\nLOG_LEVEL=info\n");
  const proj = mkdir(join(home, "proj"));
  write(join(proj, "package.json"), kuzoPkg());
  write(join(proj, ".env"), "GITHUB_TOKEN=ghp_proj\nNOTACRED=1\n");
  const nogate = mkdir(join(proj, "nogate"));
  write(join(nogate, "package.json"), JSON.stringify({ dependencies: { lodash: "^4" } }));
  write(join(nogate, ".env"), "JIRA_API_TOKEN=should-not-be-read\n");

  const sources = discoverSources({
    source: "env-file",
    knownEnvNames: KNOWN,
    home,
    cwd: nogate,
  });
  const paths = byKind(sources, "env-file").map((s) => s.path).sort();
  assert.deepEqual(paths, [join(home, ".env"), join(proj, ".env")].sort());

  const projSrc = sources.find((s) => s.path === join(proj, ".env"));
  assert.deepEqual([...projSrc!.entries.keys()], ["GITHUB_TOKEN"]); // NOTACRED filtered out
  // The un-gated dir's .env is never read.
  assert.ok(!sources.some((s) => s.path === join(nogate, ".env")));
});

test("env-file: never walks above $HOME", () => {
  // A qualifying .env ABOVE home must never be discovered.
  write(join(base, "package.json"), kuzoPkg());
  write(join(base, ".env"), "GITHUB_TOKEN=above-home-must-not-read\n");
  const proj = mkdir(join(home, "proj"));
  write(join(proj, "package.json"), kuzoPkg());
  write(join(proj, ".env"), "GITHUB_TOKEN=ghp_proj\n");

  const sources = discoverSources({ source: "env-file", knownEnvNames: KNOWN, home, cwd: proj });
  assert.ok(!sources.some((s) => s.path === join(base, ".env")), "above-home .env must be ignored");
  assert.ok(sources.some((s) => s.path === join(proj, ".env")));
});

test("env-file: the ancestor walk is capped at 5 levels above cwd", () => {
  // home/a/b/c/d/e/f/g — each with a qualifying package.json + .env.
  // cwd = .../g; the walk covers g + 5 ancestors (f,e,d,c,b) but NOT a.
  let dir = home;
  for (const name of ["a", "b", "c", "d", "e", "f", "g"]) {
    dir = mkdir(join(dir, name));
    write(join(dir, "package.json"), kuzoPkg());
    write(join(dir, ".env"), `GITHUB_TOKEN=ghp_${name}\n`);
  }
  const cwd = dir; // .../g
  const aDir = join(home, "a");

  const sources = discoverSources({ source: "env-file", knownEnvNames: KNOWN, home, cwd });
  const paths = new Set(byKind(sources, "env-file").map((s) => s.path));
  assert.ok(paths.has(join(home, "a", "b", "c", "d", "e", "f", "g", ".env")), "cwd .env present");
  assert.ok(paths.has(join(home, "a", "b", ".env")), "5th ancestor present");
  assert.ok(!paths.has(join(aDir, ".env")), "6th ancestor (a) is beyond the cap");
});
