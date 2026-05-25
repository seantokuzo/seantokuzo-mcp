/**
 * lock.test.ts — Phase 2.6 §B.6 / §B.6.1 — shared kuzo-home lock.
 *
 * Exercises the O_EXCL acquire/release, the live-holder LockBusyError, stale
 * (dead-pid) reclaim, and the canonical acquireKuzoLock path under KUZO_HOME.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { kuzoHomeLockPath } from "@kuzo-mcp/core/paths";

import { acquireFileLock, acquireKuzoLock, LockBusyError, NOOP_LOCK } from "./lock.js";

function tmpDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "kuzo-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withKuzoHome(t: TestContext): string {
  const dir = tmpDir(t);
  const prev = process.env.KUZO_HOME;
  process.env.KUZO_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.KUZO_HOME;
    else process.env.KUZO_HOME = prev;
  });
  return dir;
}

test("acquireFileLock creates the lock file and release removes it", async (t) => {
  const path = join(tmpDir(t), ".lock");
  const handle = await acquireFileLock(path, "test");
  assert.ok(existsSync(path), "lock file should exist while held");
  await handle.release();
  assert.ok(!existsSync(path), "lock file should be gone after release");
});

test("a live holder makes a second acquire throw LockBusyError", async (t) => {
  const path = join(tmpDir(t), ".lock");
  const handle = await acquireFileLock(path, "first");
  await assert.rejects(
    () => acquireFileLock(path, "second"),
    (err: unknown) => err instanceof LockBusyError,
  );
  await handle.release();
  // Reclaimable once released.
  const again = await acquireFileLock(path, "third");
  await again.release();
});

test("a stale lock (dead pid) is reclaimed", async (t) => {
  const path = join(tmpDir(t), ".lock");
  writeFileSync(
    path,
    JSON.stringify({ pid: 2147483646, command: "ghost", startedAt: new Date().toISOString() }) + "\n",
  );
  const handle = await acquireFileLock(path, "live");
  assert.ok(existsSync(path));
  await handle.release();
});

test("acquireKuzoLock acquires + releases the canonical lock under KUZO_HOME", async (t) => {
  withKuzoHome(t);
  const handle = await acquireKuzoLock("set");
  assert.ok(existsSync(kuzoHomeLockPath()), "canonical lock should exist while held");
  await handle.release();
  assert.ok(!existsSync(kuzoHomeLockPath()), "canonical lock should be gone after release");
});

test("acquireKuzoLock contends on the canonical lock", async (t) => {
  withKuzoHome(t);
  const handle = await acquireKuzoLock("set");
  await assert.rejects(
    () => acquireKuzoLock("delete"),
    (err: unknown) => err instanceof LockBusyError,
  );
  await handle.release();
});

test("NOOP_LOCK.release resolves without touching disk", async () => {
  await assert.doesNotReject(() => NOOP_LOCK.release());
});
