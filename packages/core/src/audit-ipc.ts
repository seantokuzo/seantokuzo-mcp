/**
 * Pure decision logic for parent-side validation of child audit IPC
 * traffic (spec §C.10 + §C.10.1).
 *
 * The plugin-host child runs `IpcAuditLogger.notify("audit", { event })`.
 * The parent's `plugin-process` notification handler runs the event
 * through this gauntlet in order:
 *
 *   1. Rate-limit check (in the notification handler, BEFORE this
 *      function — round-3 Security advisory). EVERY inbound IPC frame
 *      counts toward the bucket: malformed, oversize, forged, and
 *      legitimate alike. No shape of message bypasses the limit.
 *   2. Wire-shape validation (`isAuditWireEvent` + `withinAuditByteCap`).
 *      Drops with `logger.warn` rather than emitting an audit entry.
 *   3. `decideAudit` (this function): stamp PID + source → identity
 *      check → action-class allowlist → allow.
 *
 * Extracted into its own module so it can be unit-tested without
 * spinning up a real child process.
 */

import { Buffer } from "node:buffer";

import type { AuditEvent, AuditOutcome } from "./audit.js";
import { CHILD_PERMITTED_AUDIT_ACTIONS } from "./audit-partition.js";

// ---------------------------------------------------------------------------
// Wire-shape validation (spec §C.10 + round-1 review)
// ---------------------------------------------------------------------------

/**
 * Round-1 Security advisory: cap inbound audit payload size.
 * 100 events/sec × MB-scale payloads would starve fs / CPU even though
 * the token bucket caps event *count*. 16 KiB is well above any
 * legitimate audit detail (the existing emissions are all tiny) and
 * well below any DoS-relevant scale.
 */
export const AUDIT_WIRE_MAX_BYTES = 16 * 1024;

/**
 * Allowed `outcome` values — the wire validator rejects anything else.
 * Derived from the `AuditOutcome` union via a `Record<AuditOutcome, true>`
 * exhaustiveness check (round-2 Architecture advisory). If a future change
 * adds a new outcome to the union, this file fails to compile until the
 * record is updated.
 */
const AUDIT_OUTCOME_VALUES: Record<AuditOutcome, true> = {
  allowed: true,
  denied: true,
  error: true,
};
const VALID_AUDIT_OUTCOMES: ReadonlySet<string> = new Set(
  Object.keys(AUDIT_OUTCOME_VALUES),
);

/**
 * Strict shape validation for an inbound audit IPC payload. Returns false on:
 *  - wrong type / missing required string fields
 *  - `outcome` not in the closed enum (round-1 Correctness advisory)
 *  - `details` is an array rather than a plain object (round-1 Correctness)
 */
export function isAuditWireEvent(v: unknown): v is Omit<AuditEvent, "timestamp"> {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o["plugin"] !== "string") return false;
  if (typeof o["action"] !== "string") return false;
  if (typeof o["outcome"] !== "string") return false;
  if (!VALID_AUDIT_OUTCOMES.has(o["outcome"])) return false;
  if (typeof o["details"] !== "object" || o["details"] === null) return false;
  if (Array.isArray(o["details"])) return false;
  return true;
}

/**
 * Reject oversize audit payloads (round-1 Security advisory). Runs after
 * `isAuditWireEvent` succeeds — by then we know the event is structurally
 * stringifiable. Uses `Buffer.byteLength` rather than `String.length` so
 * the cap is denominated in actual UTF-8 bytes, not UTF-16 code units
 * (round-2 Security + Correctness advisory — multibyte content would
 * otherwise let the on-disk byte budget exceed the nominal cap). The
 * `try` catches the BigInt / circular-reference case that JSON.stringify
 * throws on.
 */
export function withinAuditByteCap(event: Omit<AuditEvent, "timestamp">): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf8") <= AUDIT_WIRE_MAX_BYTES;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// TokenBucket — wall-clock rate limiter (spec §C.10.1)
// ---------------------------------------------------------------------------

/**
 * Wall-clock token bucket.
 *
 * Refill is monotonic against `Date.now()`, so a slow plugin emitting
 * a few events per second indefinitely never has its burst capacity
 * consumed.
 *
 * The default capacity (200) + refill rate (100/sec) match spec §C.10.1.
 * The optional `now` constructor argument is injected for deterministic
 * unit tests; production callers omit it.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefillAt = this.now();
  }

  /** Try to consume `count` tokens. Returns false (no partial consume) if not enough. */
  consume(count = 1): boolean {
    this.refill();
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  private refill(): void {
    const now = this.now();
    const elapsedSec = (now - this.lastRefillAt) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefillAt = now;
  }
}

// ---------------------------------------------------------------------------
// AuditDecision — gauntlet outcome (spec §C.10)
// ---------------------------------------------------------------------------
//
// Rate-limiting is NOT in this decision (round-3 Security advisory).
// The notification handler in `plugin-process.ts` consumes from the
// TokenBucket BEFORE wire validation, so every shape of inbound IPC
// frame (malformed / oversize / forged / legitimate) is gated by the
// same bucket. `decideAudit` only sees events that have passed
// rate-limit + wire-shape + byte-cap.

export type AuditDecision =
  /** Child claimed a plugin identity it doesn't own — drop, emit forgery. */
  | { kind: "forged_plugin" }
  /** Child correctly claimed identity but emitted a parent-only action — drop, emit forgery. */
  | { kind: "forged_action" }
  /** Stamped event passed all checks; forward to the file-backed logger. */
  | { kind: "allow"; stamped: Omit<AuditEvent, "timestamp"> };

/**
 * Decide what to do with an inbound child audit event.
 *
 * @param event Wire-shape event from the child IpcAuditLogger.
 * @param declaredPluginName The plugin name this child was constructed with.
 * @param childPid OS pid of the child (`undefined` if not captured yet).
 */
export function decideAudit(
  event: Omit<AuditEvent, "timestamp">,
  declaredPluginName: string,
  childPid: number | undefined,
): AuditDecision {
  // 1. Construct the stamped event field-by-field rather than spreading
  //    the untrusted `event`. The wire validator only checks that the
  //    four required fields are present — it does NOT reject extra
  //    fields. A child could otherwise smuggle `timestamp` (overriding
  //    the parent's authoritative stamp via spread order downstream),
  //    `pid` (smuggling a value when `childPid` is undefined during a
  //    post-cleanup race), or `source: "parent"` (claiming parent trust
  //    boundary). Explicit construction takes only the 4 wire fields,
  //    stamps source: "child" unconditionally, and stamps the real
  //    childPid (or omits the field if undefined). Round-4 Security
  //    blocking + two related advisories.
  const stamped: Omit<AuditEvent, "timestamp"> = {
    plugin: event.plugin,
    action: event.action,
    outcome: event.outcome,
    details: event.details,
    source: "child",
    ...(childPid !== undefined ? { pid: childPid } : {}),
  };

  // 2. Plugin-identity validation.
  if (stamped.plugin !== declaredPluginName) return { kind: "forged_plugin" };

  // 3. Action-class allowlist. The Set lookup tolerates arbitrary
  //    strings — unknown actions fall through to the forgery branch.
  if (!CHILD_PERMITTED_AUDIT_ACTIONS.has(stamped.action)) return { kind: "forged_action" };

  // 4. Allow.
  return { kind: "allow", stamped };
}
