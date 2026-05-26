/**
 * migrate-fs.test.ts — Phase 2.6 §B.4 R18/R19 symlink-safe source I/O.
 */

import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { CRED_EXIT } from "./errors.js";
import {
  assertSourceUnchanged,
  atomicRewriteSource,
  safeReadSource,
} from "./migrate-fs.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kuzo-migrate-fs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function exitCodeOf(fn: () => void): number | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { exitCode?: number }).exitCode;
  }
}

test("safeReadSource: reads a regular file's bytes", () => {
  const path = join(dir, ".env");
  writeFileSync(path, "GITHUB_TOKEN=ghp_abc\n");
  assert.equal(safeReadSource(path).toString("utf-8"), "GITHUB_TOKEN=ghp_abc\n");
});

test("safeReadSource: refuses a symlink with E_SYMLINK_REFUSE (74)", () => {
  const real = join(dir, "real.env");
  const link = join(dir, "link.env");
  writeFileSync(real, "GITHUB_TOKEN=ghp_abc\n");
  symlinkSync(real, link);
  assert.equal(exitCodeOf(() => safeReadSource(link)), CRED_EXIT.E_SYMLINK_REFUSE);
});

test("safeReadSource: refuses a directory with E_NOT_REGULAR_FILE (75)", () => {
  assert.equal(exitCodeOf(() => safeReadSource(dir)), CRED_EXIT.E_NOT_REGULAR_FILE);
});

test("assertSourceUnchanged: passes when bytes match, throws E_SOURCE_MUTATED (76) when not", () => {
  const path = join(dir, ".env");
  writeFileSync(path, "GITHUB_TOKEN=ghp_abc\n");
  const snapshot = safeReadSource(path);
  assert.doesNotThrow(() => assertSourceUnchanged(path, snapshot));

  writeFileSync(path, "GITHUB_TOKEN=ghp_abc\nEXTRA=1\n"); // simulate an editor save
  assert.equal(
    exitCodeOf(() => assertSourceUnchanged(path, snapshot)),
    CRED_EXIT.E_SOURCE_MUTATED,
  );
});

test("atomicRewriteSource: replaces content and leaves no .bak / .tmp", () => {
  const path = join(dir, "settings.json");
  writeFileSync(path, '{"old":true}\n');
  atomicRewriteSource(path, '{"new":true}\n');
  assert.equal(readFileSync(path, "utf-8"), '{"new":true}\n');
  assert.throws(() => readFileSync(`${path}.tmp`, "utf-8"));
  assert.throws(() => readFileSync(`${path}.bak`, "utf-8"));
});
