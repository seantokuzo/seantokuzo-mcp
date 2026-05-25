/**
 * env-namespace.test.ts — Phase 2.6 §A.12 env-name reservation policy.
 *
 * Covers the §A.12.5 acceptance criteria for {@link validateEnvNames} (the four
 * install-time checks) plus the local-registry read/write/upsert/remove I/O.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { envNamespaceFilePath } from "../paths.js";
import {
  EnvNamespaceError,
  exitCodeForEnvNamespaceError,
  readEnvNamespaceRegistry,
  removePluginEnvNames,
  upsertPluginEnvNames,
  validateEnvNames,
  writeEnvNamespaceRegistry,
  type EnvNamespaceRegistry,
} from "./env-namespace.js";

/** Point KUZO_HOME at a fresh tmpdir for the duration of the test. */
function withKuzoHome(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "kuzo-envns-"));
  const prev = process.env.KUZO_HOME;
  process.env.KUZO_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.KUZO_HOME;
    else process.env.KUZO_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const EMPTY: EnvNamespaceRegistry = { format_version: 1, lastUpdated: "1970-01-01T00:00:00.000Z", plugins: {} };

function expectCode(fn: () => void, code: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof EnvNamespaceError, `expected EnvNamespaceError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

// ─── §A.12.3 check 1 — format ────────────────────────────────────────────────

test("format: rejects lowercase, digit-lead, dash, and over-length names", () => {
  for (const bad of ["lowercase_var", "1STARTS_WITH_DIGIT", "HAS-DASH", "A".repeat(65)]) {
    expectCode(
      () => validateEnvNames({ packageName: "@x/foo", envNames: [bad], registry: EMPTY }),
      "E_INVALID_ENV_NAME_FORMAT",
    );
  }
});

test("format: accepts a well-formed env name", () => {
  assert.doesNotThrow(() =>
    validateEnvNames({ packageName: "@x/foo", envNames: ["MYAPI_KEY"], registry: EMPTY }),
  );
});

// ─── §A.12.3 check 2 — reserved-system denylist ──────────────────────────────

test("system denylist: rejects PATH and KUZO_PASSPHRASE (passphrase-capture vector)", () => {
  for (const bad of [
    "PATH",
    "HOME",
    "NODE_OPTIONS",
    "KUZO_PASSPHRASE",
    "NPM_TOKEN",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
  ]) {
    expectCode(
      () => validateEnvNames({ packageName: "@x/foo", envNames: [bad], registry: EMPTY }),
      "E_RESERVED_SYSTEM_ENV",
    );
  }
});

// ─── §A.12.3 check 3 — first-party reservation (primary defense) ─────────────

test("first-party: a third-party plugin cannot declare GITHUB_TOKEN", () => {
  expectCode(
    () => validateEnvNames({ packageName: "@evil/clone", envNames: ["GITHUB_TOKEN"], registry: EMPTY }),
    "E_RESERVED_FIRST_PARTY_ENV",
  );
});

test("first-party: the owning plugin CAN declare its own reserved env", () => {
  assert.doesNotThrow(() =>
    validateEnvNames({
      packageName: "@kuzo-mcp/plugin-github",
      envNames: ["GITHUB_TOKEN", "GITHUB_USERNAME"],
      registry: EMPTY,
    }),
  );
});

// ─── §A.12.3 check 4 — cross-plugin collision (secondary defense) ────────────

test("collision: a second plugin cannot claim an env already in the registry", () => {
  const registry = upsertPluginEnvNames(EMPTY, "@a/foo", ["MYAPI_KEY"]);
  expectCode(
    () => validateEnvNames({ packageName: "@b/bar", envNames: ["MYAPI_KEY"], registry }),
    "E_ENV_NAME_COLLISION",
  );
});

test("collision: re-validating the SAME plugin's kept env is a no-op", () => {
  const registry = upsertPluginEnvNames(EMPTY, "@a/foo", ["MYAPI_KEY"]);
  assert.doesNotThrow(() =>
    validateEnvNames({ packageName: "@a/foo", envNames: ["MYAPI_KEY"], registry }),
  );
});

test("exitCodeForEnvNamespaceError maps each code to its §B.10 exit", () => {
  const make = (code: Parameters<typeof exitCodeForEnvNamespaceError>[0]["code"]): EnvNamespaceError =>
    new EnvNamespaceError(code, "X", "x");
  assert.equal(exitCodeForEnvNamespaceError(make("E_RESERVED_SYSTEM_ENV")), 67);
  assert.equal(exitCodeForEnvNamespaceError(make("E_RESERVED_FIRST_PARTY_ENV")), 68);
  assert.equal(exitCodeForEnvNamespaceError(make("E_ENV_NAME_COLLISION")), 69);
  assert.equal(exitCodeForEnvNamespaceError(make("E_INVALID_ENV_NAME_FORMAT")), 70);
});

test("uninstall releases the claim: removed env becomes re-claimable", () => {
  const claimed = upsertPluginEnvNames(EMPTY, "@b/bar", ["MYAPI_KEY"]);
  const released = removePluginEnvNames(claimed, "@b/bar");
  assert.doesNotThrow(() =>
    validateEnvNames({ packageName: "@b/bar", envNames: ["MYAPI_KEY"], registry: released }),
  );
});

// ─── §A.12.2 local registry I/O ──────────────────────────────────────────────

test("registry: fresh read returns an empty registry", (t) => {
  withKuzoHome(t);
  const reg = readEnvNamespaceRegistry();
  assert.equal(reg.format_version, 1);
  assert.deepEqual(reg.plugins, {});
});

test("registry: write then read round-trips the claims", (t) => {
  withKuzoHome(t);
  writeEnvNamespaceRegistry(upsertPluginEnvNames(readEnvNamespaceRegistry(), "@a/foo", ["MYAPI_KEY"]));
  const reg = readEnvNamespaceRegistry();
  assert.deepEqual(reg.plugins["@a/foo"], ["MYAPI_KEY"]);
});

test("registry: malformed JSON fails closed", (t) => {
  withKuzoHome(t);
  writeFileSync(envNamespaceFilePath(), "{ not json", "utf-8");
  assert.throws(() => readEnvNamespaceRegistry());
});

test("registry: unsupported format_version fails closed", (t) => {
  withKuzoHome(t);
  writeFileSync(
    envNamespaceFilePath(),
    JSON.stringify({ format_version: 99, lastUpdated: "x", plugins: {} }),
    "utf-8",
  );
  assert.throws(() => readEnvNamespaceRegistry());
});
