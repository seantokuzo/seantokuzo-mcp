/**
 * env-overrides.test.ts — Phase 2.6 §A.7 — `collectEnvOverrides` + `scrubProcessEnv`.
 *
 * Mutates `process.env`; each test snapshots and restores the full env around
 * its body via `withEnvIsolation(t)` so cases don't leak into each other or
 * into the test runner itself.
 *
 * Audit-emit verification uses a real `AuditLogger` pointed at a tmpdir, then
 * reads the JSONL `audit.log` back. The pure-function contract is that the
 * logger is threaded as an argument; mocking it would test the wrong thing.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { FileBackedAuditLogger, type AuditLogger } from "../audit.js";
import { collectEnvOverrides, scrubProcessEnv } from "./env-overrides.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Snapshot every key in `process.env`, restore on `t.after`. Anything the
 * test sets is removed; anything the test deleted is put back.
 */
function withEnvIsolation(t: TestContext): void {
  const snapshot: NodeJS.ProcessEnv = { ...process.env };
  t.after(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in snapshot)) delete process.env[k];
    }
    Object.assign(process.env, snapshot);
  });
}

function freshAudit(t: TestContext): { audit: AuditLogger; logPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "kuzo-scrub-audit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const audit = new FileBackedAuditLogger({ logDir: dir });
  return { audit, logPath: join(dir, "audit.log") };
}

function readAuditLines(logPath: string): Array<Record<string, unknown>> {
  const raw = readFileSync(logPath, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ─── collectEnvOverrides ───────────────────────────────────────────────────

test("collectEnvOverrides: declared plain name present → in output", (t) => {
  withEnvIsolation(t);
  process.env.GITHUB_TOKEN = "ghp_abc";
  const out = collectEnvOverrides(new Set(["GITHUB_TOKEN"]));
  assert.deepEqual(out, { GITHUB_TOKEN: "ghp_abc" });
});

test("collectEnvOverrides: declared plain name absent → not in output", (t) => {
  withEnvIsolation(t);
  delete process.env.GITHUB_TOKEN;
  const out = collectEnvOverrides(new Set(["GITHUB_TOKEN"]));
  assert.equal("GITHUB_TOKEN" in out, false);
});

test("collectEnvOverrides: KUZO_TOKEN_<NAME> picked up, keyed by <NAME>", (t) => {
  withEnvIsolation(t);
  delete process.env.GITHUB_TOKEN;
  process.env.KUZO_TOKEN_GITHUB_TOKEN = "ghp_namespaced";
  const out = collectEnvOverrides(new Set(["GITHUB_TOKEN"]));
  assert.equal(out.GITHUB_TOKEN, "ghp_namespaced");
});

test("collectEnvOverrides: KUZO_TOKEN_<NAME> beats plain when both set", (t) => {
  withEnvIsolation(t);
  process.env.GITHUB_TOKEN = "ghp_plain";
  process.env.KUZO_TOKEN_GITHUB_TOKEN = "ghp_namespaced";
  const out = collectEnvOverrides(new Set(["GITHUB_TOKEN"]));
  assert.equal(out.GITHUB_TOKEN, "ghp_namespaced");
});

test("collectEnvOverrides: empty-string plain value treated as not-set", (t) => {
  withEnvIsolation(t);
  process.env.GITHUB_TOKEN = "";
  const out = collectEnvOverrides(new Set(["GITHUB_TOKEN"]));
  assert.equal("GITHUB_TOKEN" in out, false);
});

test("collectEnvOverrides: empty-string KUZO_TOKEN_<NAME> treated as not-set", (t) => {
  withEnvIsolation(t);
  process.env.KUZO_TOKEN_GITHUB_TOKEN = "";
  const out = collectEnvOverrides(new Set(["GITHUB_TOKEN"]));
  assert.equal("GITHUB_TOKEN" in out, false);
});

test("collectEnvOverrides: KUZO_TOKEN_* entries collected even when name not declared", (t) => {
  // Theme 4 §A.12 reservation gate is what rejects undeclared names; the
  // collector is permissive on purpose so the rejection can produce a clear
  // error (else the offending entry would silently disappear here).
  withEnvIsolation(t);
  process.env.KUZO_TOKEN_UNDECLARED_TOKEN = "rogue";
  const out = collectEnvOverrides(new Set(["GITHUB_TOKEN"]));
  assert.equal(out.UNDECLARED_TOKEN, "rogue");
});

test("collectEnvOverrides: empty declaredEnvNames + no KUZO_TOKEN_* → empty output", (t) => {
  withEnvIsolation(t);
  // Delete any KUZO_TOKEN_* the runner may already have set.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("KUZO_TOKEN_")) delete process.env[k];
  }
  const out = collectEnvOverrides(new Set());
  assert.deepEqual(out, {});
});

test("collectEnvOverrides: multiple declared names, mixed presence", (t) => {
  withEnvIsolation(t);
  process.env.GITHUB_TOKEN = "ghp_x";
  delete process.env.JIRA_API_TOKEN;
  process.env.KUZO_TOKEN_JIRA_API_TOKEN = "jira_namespaced";
  const out = collectEnvOverrides(new Set(["GITHUB_TOKEN", "JIRA_API_TOKEN", "ABSENT"]));
  assert.deepEqual(out, { GITHUB_TOKEN: "ghp_x", JIRA_API_TOKEN: "jira_namespaced" });
});

// ─── scrubProcessEnv — kill-switch inactive ────────────────────────────────

test("scrubProcessEnv: declared keys deleted from process.env", (t) => {
  withEnvIsolation(t);
  process.env.GITHUB_TOKEN = "ghp_x";
  process.env.JIRA_API_TOKEN = "jira_x";
  delete process.env.KUZO_NO_ENV_SCRUB;
  const result = scrubProcessEnv(["GITHUB_TOKEN", "JIRA_API_TOKEN"]);
  assert.equal(process.env.GITHUB_TOKEN, undefined);
  assert.equal(process.env.JIRA_API_TOKEN, undefined);
  assert.equal(result.killSwitchActive, false);
});

test("scrubProcessEnv: KUZO_TOKEN_<NAME> twin also deleted for declared keys", (t) => {
  withEnvIsolation(t);
  process.env.GITHUB_TOKEN = "ghp_plain";
  process.env.KUZO_TOKEN_GITHUB_TOKEN = "ghp_namespaced";
  delete process.env.KUZO_NO_ENV_SCRUB;
  scrubProcessEnv(["GITHUB_TOKEN"]);
  assert.equal(process.env.GITHUB_TOKEN, undefined);
  assert.equal(process.env.KUZO_TOKEN_GITHUB_TOKEN, undefined);
});

test("scrubProcessEnv: KUZO_PASSPHRASE always deleted (in ALWAYS_SCRUB)", (t) => {
  withEnvIsolation(t);
  process.env.KUZO_PASSPHRASE = "hunter2";
  delete process.env.KUZO_NO_ENV_SCRUB;
  scrubProcessEnv([]);
  assert.equal(process.env.KUZO_PASSPHRASE, undefined);
});

test("scrubProcessEnv: scrubbedCount accurate for declared + twin pair", (t) => {
  withEnvIsolation(t);
  process.env.GITHUB_TOKEN = "ghp_plain";
  process.env.KUZO_TOKEN_GITHUB_TOKEN = "ghp_namespaced";
  delete process.env.KUZO_NO_ENV_SCRUB;
  delete process.env.KUZO_PASSPHRASE;
  const result = scrubProcessEnv(["GITHUB_TOKEN"]);
  // 2: GITHUB_TOKEN + KUZO_TOKEN_GITHUB_TOKEN.
  assert.equal(result.scrubbedCount, 2);
});

test("scrubProcessEnv: scrubbedCount only counts keys actually present", (t) => {
  withEnvIsolation(t);
  // Nothing set — neither declared name nor passphrase nor kill-switch.
  delete process.env.GITHUB_TOKEN;
  delete process.env.KUZO_TOKEN_GITHUB_TOKEN;
  delete process.env.KUZO_PASSPHRASE;
  delete process.env.KUZO_NO_ENV_SCRUB;
  const result = scrubProcessEnv(["GITHUB_TOKEN"]);
  assert.equal(result.scrubbedCount, 0);
});

test("scrubProcessEnv: no audit emit when kill-switch inactive (even with logger)", (t) => {
  withEnvIsolation(t);
  process.env.GITHUB_TOKEN = "ghp_x";
  delete process.env.KUZO_NO_ENV_SCRUB;
  const { audit, logPath } = freshAudit(t);
  scrubProcessEnv(["GITHUB_TOKEN"], audit);
  // No scrub_disabled emit — and no audit.log file at all if no other action
  // wrote to it. Acceptable to skip the read if file is absent.
  let lines: Array<Record<string, unknown>> = [];
  try {
    lines = readAuditLines(logPath);
  } catch {
    // File absent — nothing was logged. That's the assertion.
  }
  const scrubEvents = lines.filter((l) => l.action === "credential.scrub_disabled");
  assert.deepEqual(scrubEvents, []);
});

// ─── scrubProcessEnv — kill-switch active ──────────────────────────────────

test("scrubProcessEnv: kill-switch preserves declared keys", (t) => {
  withEnvIsolation(t);
  process.env.GITHUB_TOKEN = "ghp_x";
  process.env.JIRA_API_TOKEN = "jira_x";
  process.env.KUZO_NO_ENV_SCRUB = "1";
  const result = scrubProcessEnv(["GITHUB_TOKEN", "JIRA_API_TOKEN"]);
  assert.equal(process.env.GITHUB_TOKEN, "ghp_x");
  assert.equal(process.env.JIRA_API_TOKEN, "jira_x");
  assert.equal(result.killSwitchActive, true);
});

test("scrubProcessEnv: kill-switch preserves KUZO_TOKEN_<NAME> twins", (t) => {
  withEnvIsolation(t);
  process.env.KUZO_TOKEN_GITHUB_TOKEN = "ghp_namespaced";
  process.env.KUZO_NO_ENV_SCRUB = "1";
  scrubProcessEnv(["GITHUB_TOKEN"]);
  assert.equal(process.env.KUZO_TOKEN_GITHUB_TOKEN, "ghp_namespaced");
});

test("scrubProcessEnv: kill-switch still deletes KUZO_PASSPHRASE (ALWAYS_SCRUB)", (t) => {
  withEnvIsolation(t);
  process.env.KUZO_PASSPHRASE = "hunter2";
  process.env.KUZO_NO_ENV_SCRUB = "1";
  scrubProcessEnv([]);
  assert.equal(process.env.KUZO_PASSPHRASE, undefined);
});

test("scrubProcessEnv: kill-switch scrubs KUZO_NO_ENV_SCRUB itself (round-4 A2)", (t) => {
  withEnvIsolation(t);
  process.env.KUZO_NO_ENV_SCRUB = "1";
  const result = scrubProcessEnv([]);
  // The kill-switch was active for THIS call, but the env var must be gone
  // so plugin children can't observe it.
  assert.equal(process.env.KUZO_NO_ENV_SCRUB, undefined);
  assert.equal(result.killSwitchActive, true);
});

test("scrubProcessEnv: kill-switch does NOT prefix-delete ALWAYS_SCRUB entries (round-4 N1)", (t) => {
  withEnvIsolation(t);
  // Even an absurd entry like KUZO_TOKEN_KUZO_PASSPHRASE must NOT be deleted
  // by the prefix sweep — ALWAYS_SCRUB names are system/meta, not credential
  // targets. If set (it shouldn't be in real life), it stays.
  process.env.KUZO_TOKEN_KUZO_PASSPHRASE = "sentinel";
  process.env.KUZO_NO_ENV_SCRUB = "1";
  scrubProcessEnv([]);
  assert.equal(process.env.KUZO_TOKEN_KUZO_PASSPHRASE, "sentinel");
});

test("scrubProcessEnv: kill-switch + audit logger → credential.scrub_disabled emitted", (t) => {
  withEnvIsolation(t);
  process.env.GITHUB_TOKEN = "ghp_x";
  process.env.KUZO_NO_ENV_SCRUB = "1";
  const { audit, logPath } = freshAudit(t);
  scrubProcessEnv(["GITHUB_TOKEN", "JIRA_API_TOKEN"], audit);
  const lines = readAuditLines(logPath);
  const scrubEvents = lines.filter((l) => l.action === "credential.scrub_disabled");
  assert.equal(scrubEvents.length, 1);
  const ev = scrubEvents[0]!;
  assert.equal(ev.plugin, "kuzo");
  assert.equal(ev.outcome, "allowed");
  const details = ev.details as Record<string, unknown>;
  assert.equal(details.reason, "KUZO_NO_ENV_SCRUB=1");
  assert.equal(details.declared_skipped, 2);
});

test("scrubProcessEnv: kill-switch + NO logger → no throw, no emit", (t) => {
  withEnvIsolation(t);
  process.env.KUZO_NO_ENV_SCRUB = "1";
  // Should not throw; pure function tolerates absent auditLogger.
  const result = scrubProcessEnv(["GITHUB_TOKEN"]);
  assert.equal(result.killSwitchActive, true);
});

// ─── scrubProcessEnv — return shape ────────────────────────────────────────

test("scrubProcessEnv: scrubbedCount counts ALWAYS_SCRUB entries when present", (t) => {
  withEnvIsolation(t);
  process.env.KUZO_PASSPHRASE = "x";
  process.env.KUZO_NO_ENV_SCRUB = "1";
  const result = scrubProcessEnv([]);
  // Both ALWAYS_SCRUB entries were present → both counted.
  assert.equal(result.scrubbedCount, 2);
});
