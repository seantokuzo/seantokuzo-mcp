/**
 * serve-summary.ts — §D.3 first-run UX tests. Run via `pnpm test:credentials`.
 */

import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";

import type { LoadResult } from "@kuzo-mcp/types";

import { buildServeSummary } from "./serve-summary.js";

function loadResult(over: Partial<LoadResult> = {}): LoadResult {
  return { loaded: [], skipped: [], failed: [], ...over };
}

test("ready line + per-plugin OK lines on a clean load", (_t: TestContext) => {
  const out = buildServeSummary({
    loadResult: loadResult({ loaded: ["git-context", "github"] }),
    envOverrideNames: ["GITHUB_TOKEN"],
    storeSize: 2,
    suppressMigrateNudge: false,
  }).join("\n");

  assert.match(out, /\[kuzo\] ready — 2 plugins loaded, 0 skipped/);
  assert.match(out, /\[kuzo\] git-context: OK/);
  assert.match(out, /\[kuzo\] github: OK/);
  // Creds present in env + store → no first-run / migrate messaging.
  assert.doesNotMatch(out, /No credentials configured/);
  assert.doesNotMatch(out, /Detected unencrypted credentials/);
});

test("missing-credential skip renders the friendly line + a set hint", (_t: TestContext) => {
  const out = buildServeSummary({
    loadResult: loadResult({
      loaded: ["github"],
      skipped: [
        { name: "jira", reason: "missing required config: JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN" },
      ],
    }),
    envOverrideNames: ["GITHUB_TOKEN"],
    storeSize: 1,
    suppressMigrateNudge: false,
  }).join("\n");

  assert.match(
    out,
    /\[kuzo\] jira: SKIPPED — missing credentials \(JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN\)/,
  );
  assert.match(out, /Run `kuzo credentials set <name>` to configure\./);
});

test("non-credential skip renders the raw reason, no set hint", (_t: TestContext) => {
  const out = buildServeSummary({
    loadResult: loadResult({
      loaded: ["github"],
      skipped: [{ name: "legacy", reason: "disabled in config" }],
    }),
    envOverrideNames: ["GITHUB_TOKEN"],
    storeSize: 1,
    suppressMigrateNudge: false,
  }).join("\n");

  assert.match(out, /\[kuzo\] legacy: SKIPPED — disabled in config/);
  assert.doesNotMatch(out, /Run `kuzo credentials set/);
});

test("zero creds anywhere → first-run message, no set hint, no migrate nudge", (_t: TestContext) => {
  const out = buildServeSummary({
    loadResult: loadResult({
      skipped: [{ name: "github", reason: "missing required config: GITHUB_TOKEN" }],
    }),
    envOverrideNames: [],
    storeSize: 0,
    suppressMigrateNudge: false,
  }).join("\n");

  assert.match(out, /No credentials configured\. Plugins requiring credentials will be skipped\./);
  assert.match(out, /To configure: `kuzo credentials set GITHUB_TOKEN`/);
  // The first-run two-liner subsumes the generic set hint; don't double up.
  assert.doesNotMatch(out, /Run `kuzo credentials set <name>` to configure\./);
  // No env creds → nothing to migrate.
  assert.doesNotMatch(out, /Detected unencrypted credentials/);
});

test("R35 upgrade nudge fires when env creds present but store empty", (_t: TestContext) => {
  const out = buildServeSummary({
    loadResult: loadResult({ loaded: ["github"] }),
    envOverrideNames: ["GITHUB_TOKEN"],
    storeSize: 0,
    suppressMigrateNudge: false,
  }).join("\n");

  assert.match(out, /Detected unencrypted credentials in your environment\./);
  assert.match(out, /Run 'kuzo credentials migrate' to move them to the encrypted store\./);
  // Env creds exist → not the brand-new zero-cred case.
  assert.doesNotMatch(out, /No credentials configured/);
});

test("R35 upgrade nudge suppressed by KUZO_NO_MIGRATE_NUDGE", (_t: TestContext) => {
  const out = buildServeSummary({
    loadResult: loadResult({ loaded: ["github"] }),
    envOverrideNames: ["GITHUB_TOKEN"],
    storeSize: 0,
    suppressMigrateNudge: true,
  }).join("\n");

  assert.doesNotMatch(out, /Detected unencrypted credentials/);
});

test("R35 upgrade nudge does NOT fire once credentials are stored", (_t: TestContext) => {
  const out = buildServeSummary({
    loadResult: loadResult({ loaded: ["github"] }),
    envOverrideNames: ["GITHUB_TOKEN"],
    storeSize: 3,
    suppressMigrateNudge: false,
  }).join("\n");

  assert.doesNotMatch(out, /Detected unencrypted credentials/);
});
