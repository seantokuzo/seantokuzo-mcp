/**
 * Unit tests for the child-audit IPC decision logic (spec §C.10 + §C.10.1).
 *
 * Run via the root `test:audit` script:
 *   KUZO_TEST=1 node --import tsx --test packages/core/src/audit-ipc.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AuditEvent } from "./audit.js";
import { AUDIT_ACTION_PARTITION, CHILD_PERMITTED_AUDIT_ACTIONS } from "./audit-partition.js";
import {
  AUDIT_WIRE_MAX_BYTES,
  TokenBucket,
  decideAudit,
  isAuditWireEvent,
  withinAuditByteCap,
} from "./audit-ipc.js";

// ─── helpers ──────────────────────────────────────────────────────────────

/** Build a `now()` source that returns whatever the test sets. */
function fakeClock(initial = 0): { now: () => number; advance: (ms: number) => void } {
  let t = initial;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function legitEvent(): Omit<AuditEvent, "timestamp"> {
  return {
    plugin: "github",
    action: "credential.client_created",
    outcome: "allowed",
    details: { service: "github" },
  };
}

// ─── TokenBucket ──────────────────────────────────────────────────────────

test("TokenBucket: burst capacity is consumable", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket(200, 100, clock.now);
  for (let i = 0; i < 200; i++) {
    assert.equal(bucket.consume(1), true, `consume #${i + 1} should succeed`);
  }
});

test("TokenBucket: 201st consume on a brand-new bucket fails", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket(200, 100, clock.now);
  for (let i = 0; i < 200; i++) bucket.consume(1);
  assert.equal(bucket.consume(1), false);
});

test("TokenBucket: refill replenishes at refillPerSec wall-clock", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket(200, 100, clock.now);
  for (let i = 0; i < 200; i++) bucket.consume(1);
  assert.equal(bucket.consume(1), false);

  // 100ms wall-clock → 100/sec * 0.1s = 10 tokens refilled.
  clock.advance(100);
  for (let i = 0; i < 10; i++) {
    assert.equal(bucket.consume(1), true, `refill consume #${i + 1} should succeed`);
  }
  assert.equal(bucket.consume(1), false, "11th should fail — only 10 refilled");
});

test("TokenBucket: refill is capped at capacity (no overflow)", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket(200, 100, clock.now);
  bucket.consume(50); // 150 remaining

  // Advance an hour — without the cap, refill would add 360_000 tokens.
  clock.advance(60 * 60 * 1000);
  // Capacity is 200 — we should be able to consume exactly 200 and no more.
  for (let i = 0; i < 200; i++) {
    assert.equal(bucket.consume(1), true, `post-cap consume #${i + 1} should succeed`);
  }
  assert.equal(bucket.consume(1), false, "201st post-cap consume should fail");
});

test("TokenBucket: no partial consume — consume(N) all-or-nothing", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket(5, 1, clock.now);
  assert.equal(bucket.consume(10), false, "asking for more than capacity returns false");
  // Bucket should still hold all 5 tokens.
  for (let i = 0; i < 5; i++) {
    assert.equal(bucket.consume(1), true, `unchanged consume #${i + 1} should succeed`);
  }
  assert.equal(bucket.consume(1), false);
});

// ─── decideAudit: happy path ──────────────────────────────────────────────
//
// Round-3 refactor: rate-limit lives in the IPC notification handler now,
// not in decideAudit. The TokenBucket tests above still cover the bucket
// itself. The decideAudit tests below cover stamp + identity + action-class.

test("decideAudit: legit child-permitted action → allow + stamps source + pid", () => {
  const decision = decideAudit(legitEvent(), "github", 12345);

  assert.equal(decision.kind, "allow");
  if (decision.kind !== "allow") return;
  assert.equal(decision.stamped.source, "child");
  assert.equal(decision.stamped.pid, 12345);
  assert.equal(decision.stamped.plugin, "github");
  assert.equal(decision.stamped.action, "credential.client_created");
});

test("decideAudit: undefined childPid → no pid field on the stamped event", () => {
  const decision = decideAudit(legitEvent(), "github", undefined);

  assert.equal(decision.kind, "allow");
  if (decision.kind !== "allow") return;
  assert.equal(decision.stamped.source, "child");
  assert.equal("pid" in decision.stamped, false, "pid must not be present when childPid undefined");
});

test("decideAudit: caller-supplied source/pid are overwritten by the stamp", () => {
  const event: Omit<AuditEvent, "timestamp"> = {
    ...legitEvent(),
    source: "parent",   // child trying to claim parent — must be overwritten
    pid: 99999,         // child trying to spoof pid — must be overwritten
  };
  const decision = decideAudit(event, "github", 12345);

  assert.equal(decision.kind, "allow");
  if (decision.kind !== "allow") return;
  assert.equal(decision.stamped.source, "child", "source MUST be overwritten to child");
  assert.equal(decision.stamped.pid, 12345, "pid MUST be overwritten to the real child PID");
});

// ─── decideAudit: plugin-identity forgery ─────────────────────────────────

test("decideAudit: plugin field mismatch → forged_plugin", () => {
  const event = { ...legitEvent(), plugin: "kuzo" }; // claiming core
  const decision = decideAudit(event, "github", 12345);
  assert.equal(decision.kind, "forged_plugin");
});

test("decideAudit: cross-plugin impersonation → forged_plugin", () => {
  const event = { ...legitEvent(), plugin: "jira" }; // github child claiming to be jira
  const decision = decideAudit(event, "github", 12345);
  assert.equal(decision.kind, "forged_plugin");
});

// ─── decideAudit: action-class forgery ────────────────────────────────────

test("decideAudit: parent-only action → forged_action", () => {
  const event: Omit<AuditEvent, "timestamp"> = {
    plugin: "github",
    action: "consent.granted", // parent-only
    outcome: "allowed",
    details: {},
  };
  const decision = decideAudit(event, "github", 12345);
  assert.equal(decision.kind, "forged_action");
});

test("decideAudit: unknown action string → forged_action (Set lookup tolerates)", () => {
  // Pretend the wire layer let through an action not in the union.
  const event: Omit<AuditEvent, "timestamp"> = {
    plugin: "github",
    action: "credential.totally_made_up" as never,
    outcome: "allowed",
    details: {},
  };
  const decision = decideAudit(event, "github", 12345);
  assert.equal(decision.kind, "forged_action");
});

// ─── partition exhaustiveness + invariants ────────────────────────────────

test("CHILD_PERMITTED_AUDIT_ACTIONS contains exactly the 4 read-side broker events", () => {
  // Spec §C.10: the partition's child-permitted side is the exact set of
  // read-side broker emissions. Adding a new child-permitted action requires
  // updating this test too (so the security review can't be silently widened).
  const expected = new Set([
    "credential.client_created",
    "credential.raw_access",
    "credential.raw_denied",
    "credential.fetch_created",
  ]);
  assert.equal(CHILD_PERMITTED_AUDIT_ACTIONS.size, expected.size);
  for (const action of expected) {
    assert.equal(
      CHILD_PERMITTED_AUDIT_ACTIONS.has(action as never),
      true,
      `${action} must be child-permitted`,
    );
  }
});

// ─── wire validator (round-1 Security + Correctness advisories) ──────────

test("isAuditWireEvent: legit shape passes", () => {
  assert.equal(
    isAuditWireEvent({
      plugin: "github",
      action: "credential.client_created",
      outcome: "allowed",
      details: {},
    }),
    true,
  );
});

test("isAuditWireEvent: missing plugin → false", () => {
  assert.equal(
    isAuditWireEvent({ action: "x", outcome: "allowed", details: {} }),
    false,
  );
});

test("isAuditWireEvent: non-enum outcome → false", () => {
  assert.equal(
    isAuditWireEvent({
      plugin: "github",
      action: "credential.client_created",
      outcome: "totally_made_up",
      details: {},
    }),
    false,
    "outcome must be in the closed enum",
  );
});

for (const outcome of ["allowed", "denied", "error"] as const) {
  test(`isAuditWireEvent: outcome="${outcome}" accepted`, () => {
    assert.equal(
      isAuditWireEvent({
        plugin: "github",
        action: "credential.client_created",
        outcome,
        details: {},
      }),
      true,
    );
  });
}

test("isAuditWireEvent: array details → false (must be plain object)", () => {
  assert.equal(
    isAuditWireEvent({
      plugin: "github",
      action: "credential.client_created",
      outcome: "allowed",
      details: [1, 2, 3],
    }),
    false,
  );
});

test("isAuditWireEvent: null details → false", () => {
  assert.equal(
    isAuditWireEvent({
      plugin: "github",
      action: "credential.client_created",
      outcome: "allowed",
      details: null,
    }),
    false,
  );
});

test("isAuditWireEvent: string details → false", () => {
  assert.equal(
    isAuditWireEvent({
      plugin: "github",
      action: "credential.client_created",
      outcome: "allowed",
      details: "not an object",
    }),
    false,
  );
});

test("isAuditWireEvent: non-object input → false", () => {
  assert.equal(isAuditWireEvent(null), false);
  assert.equal(isAuditWireEvent(undefined), false);
  assert.equal(isAuditWireEvent("string"), false);
  assert.equal(isAuditWireEvent(42), false);
});

// ─── withinAuditByteCap (round-1 Security advisory) ──────────────────────

test("withinAuditByteCap: small event passes", () => {
  assert.equal(
    withinAuditByteCap({
      plugin: "github",
      action: "credential.client_created",
      outcome: "allowed",
      details: { service: "github" },
    }),
    true,
  );
});

test("withinAuditByteCap: event larger than AUDIT_WIRE_MAX_BYTES fails", () => {
  const big = "x".repeat(AUDIT_WIRE_MAX_BYTES + 1);
  assert.equal(
    withinAuditByteCap({
      plugin: "github",
      action: "credential.client_created",
      outcome: "allowed",
      details: { payload: big },
    }),
    false,
  );
});

test("withinAuditByteCap: BigInt detail throws JSON.stringify → rejected", () => {
  assert.equal(
    withinAuditByteCap({
      plugin: "github",
      action: "credential.client_created",
      outcome: "allowed",
      // BigInt isn't JSON-serializable.
      details: { huge: 12345678901234567890n as unknown as number },
    }),
    false,
  );
});

test("withinAuditByteCap: cap is denominated in UTF-8 bytes, not UTF-16 code units (round-2 fix)", () => {
  // Each "💥" is 1 UTF-16 surrogate pair (.length === 2) but 4 UTF-8 bytes.
  // Half the cap in UTF-16 code units = the FULL cap in bytes (assuming
  // all content is 💥). Round-1 used .length and would have accepted
  // double the byte budget.
  const halfCapInUtf16Units = "💥".repeat(AUDIT_WIRE_MAX_BYTES / 4 + 1);
  assert.equal(
    withinAuditByteCap({
      plugin: "github",
      action: "credential.client_created",
      outcome: "allowed",
      details: { payload: halfCapInUtf16Units },
    }),
    false,
    "must reject when UTF-8 byte length exceeds the cap, even though UTF-16 length would have fit",
  );
});

// ─── partition exhaustiveness + invariants ────────────────────────────────

test("AUDIT_ACTION_PARTITION classifies every union variant (no 'undefined' values)", () => {
  // The `Record<AuditAction, ...>` literal type enforces this at compile
  // time — TypeScript would refuse to compile audit-partition.ts if any
  // variant were missing. This runtime check is belt-and-suspenders for the
  // reviewer reading the test output.
  for (const [action, scope] of Object.entries(AUDIT_ACTION_PARTITION)) {
    assert.notEqual(scope, undefined, `${action} has undefined scope`);
    assert.ok(
      scope === "parent-only" || scope === "child-permitted",
      `${action} has unexpected scope "${scope}"`,
    );
  }
});
