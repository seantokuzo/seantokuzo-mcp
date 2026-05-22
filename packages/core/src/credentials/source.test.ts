/**
 * source.test.ts — Phase 2.6 §A.6 — `CredentialSource` merge semantics.
 *
 * Exercises the env-override-wins-over-store rule against a real
 * `EncryptedCredentialStore` (production path) with `InMemoryKeyProvider`
 * (no keychain dependency). The `extractForPlugin` cases cover the
 * Theme 4 loader-rewrite contract: required tracked in `missing`, optional
 * silently omitted, calling shape matches `ConfigManager.extractPluginConfig`.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { CredentialCapability } from "@kuzo-mcp/types";

import { CredentialSource } from "./source.js";
import { EncryptedCredentialStore } from "./store.js";
import { InMemoryKeyProvider } from "./testing.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function freshStore(t: TestContext): EncryptedCredentialStore {
  const dir = mkdtempSync(join(tmpdir(), "kuzo-source-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new EncryptedCredentialStore({
    filePath: join(dir, "credentials.enc"),
    keyProvider: new InMemoryKeyProvider(),
  });
}

function cap(env: string): CredentialCapability {
  return {
    kind: "credentials",
    env,
    access: "raw",
    reason: `test cap for ${env}`,
  };
}

// ─── get() semantics ───────────────────────────────────────────────────────

test("get() returns env override when present", (t) => {
  const store = freshStore(t);
  const source = new CredentialSource(store, { GITHUB_TOKEN: "from-env" });
  assert.equal(source.get("GITHUB_TOKEN"), "from-env");
});

test("get() falls through to store when env override missing", (t) => {
  const store = freshStore(t);
  store.set("GITHUB_TOKEN", "from-store");
  const source = new CredentialSource(store, {});
  assert.equal(source.get("GITHUB_TOKEN"), "from-store");
});

test("get() env override beats store for the same key", (t) => {
  const store = freshStore(t);
  store.set("GITHUB_TOKEN", "from-store");
  const source = new CredentialSource(store, { GITHUB_TOKEN: "from-env" });
  assert.equal(source.get("GITHUB_TOKEN"), "from-env");
});

test("get() returns undefined when neither env nor store has the key", (t) => {
  const store = freshStore(t);
  const source = new CredentialSource(store, {});
  assert.equal(source.get("MISSING"), undefined);
});

test("get() honors Object.hasOwn — explicit empty-string override returns ''", (t) => {
  // collectEnvOverrides filters empties, but the CredentialSource layer is
  // agnostic: presence in the Record == use that value. Verifies the
  // hasOwn check (not truthiness) for callers that intentionally bypass
  // the collector — e.g. Theme 4's `--no-env-overrides` test harness.
  const store = freshStore(t);
  store.set("GITHUB_TOKEN", "from-store");
  const source = new CredentialSource(store, { GITHUB_TOKEN: "" });
  assert.equal(source.get("GITHUB_TOKEN"), "");
});

// ─── has() semantics ───────────────────────────────────────────────────────

test("has() returns true when env override is present", (t) => {
  const store = freshStore(t);
  const source = new CredentialSource(store, { GITHUB_TOKEN: "x" });
  assert.equal(source.has("GITHUB_TOKEN"), true);
});

test("has() returns true when store has the key (after unlock)", (t) => {
  const store = freshStore(t);
  store.set("GITHUB_TOKEN", "x"); // unlocks the store as a side-effect
  const source = new CredentialSource(store, {});
  assert.equal(source.has("GITHUB_TOKEN"), true);
});

test("has() returns false when neither source has the key", (t) => {
  const store = freshStore(t);
  store.set("OTHER", "x"); // ensure store is unlocked but key absent
  const source = new CredentialSource(store, {});
  assert.equal(source.has("MISSING"), false);
});

// ─── extractForPlugin — required ───────────────────────────────────────────

test("extractForPlugin: required + present (env) → config populated, missing empty", (t) => {
  const store = freshStore(t);
  const source = new CredentialSource(store, { GITHUB_TOKEN: "from-env" });
  const { config, missing } = source.extractForPlugin({
    required: [cap("GITHUB_TOKEN")],
    optional: [],
  });
  assert.equal(config.get("GITHUB_TOKEN"), "from-env");
  assert.deepEqual(missing, []);
});

test("extractForPlugin: required + present (store) → config populated, missing empty", (t) => {
  const store = freshStore(t);
  store.set("GITHUB_TOKEN", "from-store");
  const source = new CredentialSource(store, {});
  const { config, missing } = source.extractForPlugin({
    required: [cap("GITHUB_TOKEN")],
    optional: [],
  });
  assert.equal(config.get("GITHUB_TOKEN"), "from-store");
  assert.deepEqual(missing, []);
});

test("extractForPlugin: required + missing → missing array populated, key absent from config", (t) => {
  const store = freshStore(t);
  const source = new CredentialSource(store, {});
  const { config, missing } = source.extractForPlugin({
    required: [cap("GITHUB_TOKEN")],
    optional: [],
  });
  assert.equal(config.has("GITHUB_TOKEN"), false);
  assert.deepEqual(missing, ["GITHUB_TOKEN"]);
});

// ─── extractForPlugin — optional ───────────────────────────────────────────

test("extractForPlugin: optional + present → config populated, missing empty", (t) => {
  const store = freshStore(t);
  const source = new CredentialSource(store, { GITHUB_USERNAME: "seantokuzo" });
  const { config, missing } = source.extractForPlugin({
    required: [],
    optional: [cap("GITHUB_USERNAME")],
  });
  assert.equal(config.get("GITHUB_USERNAME"), "seantokuzo");
  assert.deepEqual(missing, []);
});

test("extractForPlugin: optional + missing → silent omission (not in config, not in missing)", (t) => {
  const store = freshStore(t);
  const source = new CredentialSource(store, {});
  const { config, missing } = source.extractForPlugin({
    required: [],
    optional: [cap("GITHUB_USERNAME")],
  });
  assert.equal(config.has("GITHUB_USERNAME"), false);
  assert.deepEqual(missing, []);
});

// ─── extractForPlugin — combined ───────────────────────────────────────────

test("extractForPlugin: mix of required+optional, partial population", (t) => {
  const store = freshStore(t);
  store.set("JIRA_API_TOKEN", "from-store");
  const source = new CredentialSource(store, { GITHUB_TOKEN: "from-env" });
  const { config, missing } = source.extractForPlugin({
    required: [cap("GITHUB_TOKEN"), cap("JIRA_API_TOKEN"), cap("ABSENT_REQ")],
    optional: [cap("GITHUB_USERNAME"), cap("ABSENT_OPT")],
  });

  assert.equal(config.get("GITHUB_TOKEN"), "from-env");
  assert.equal(config.get("JIRA_API_TOKEN"), "from-store");
  assert.equal(config.has("ABSENT_REQ"), false);
  assert.equal(config.has("GITHUB_USERNAME"), false);
  assert.equal(config.has("ABSENT_OPT"), false);

  assert.deepEqual(missing, ["ABSENT_REQ"]);
  assert.equal(config.size, 2);
});

test("extractForPlugin: env override beats store for the same cap.env", (t) => {
  const store = freshStore(t);
  store.set("GITHUB_TOKEN", "from-store");
  const source = new CredentialSource(store, { GITHUB_TOKEN: "from-env" });
  const { config, missing } = source.extractForPlugin({
    required: [cap("GITHUB_TOKEN")],
    optional: [],
  });
  assert.equal(config.get("GITHUB_TOKEN"), "from-env");
  assert.deepEqual(missing, []);
});

test("extractForPlugin: empty required + empty optional → empty config + empty missing", (t) => {
  const store = freshStore(t);
  const source = new CredentialSource(store, {});
  const { config, missing } = source.extractForPlugin({
    required: [],
    optional: [],
  });
  assert.equal(config.size, 0);
  assert.deepEqual(missing, []);
});
