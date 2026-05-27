/**
 * debounce.ts — §C.11 helper tests. Run via `pnpm test:credentials`.
 */

import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";

import { debounce } from "./debounce.js";

test("debounce returns a Promise that resolves", async (_t: TestContext) => {
  const result = debounce(0);
  assert.ok(result instanceof Promise);
  await result; // resolves without throwing
});

test("debounce waits at least the requested delay", async (_t: TestContext) => {
  const start = Date.now();
  await debounce(30);
  const elapsed = Date.now() - start;
  // setTimeout never fires before its delay; allow a few ms of measurement
  // slack so the assertion isn't flaky on a loaded runner.
  assert.ok(elapsed >= 25, `expected >= ~30ms, got ${elapsed}ms`);
});
