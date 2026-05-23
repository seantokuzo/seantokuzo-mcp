/**
 * Pure decision logic for parent-side validation of child audit IPC
 * traffic (spec §C.10 + §C.10.1).
 *
 * The plugin-host child runs `IpcAuditLogger.notify("audit", { event })`.
 * The parent's `plugin-process.handleAuditEvent` receives the
 * notification and runs the event through this gauntlet in order:
 *
 *   1. Rate-limit check — `TokenBucket.consume(1)`. Forged emissions
 *      consume tokens too so the rate limit can't be bypassed by
 *      emitting only forgeries.
 *   2. PID + source stamp — overwrites any caller-supplied value.
 *   3. Plugin-identity validation — `event.plugin` must equal the
 *      child's declared plugin name. Mismatch → `forged_plugin`.
 *   4. Action-class allowlist — `event.action` must be a member of
 *      `CHILD_PERMITTED_AUDIT_ACTIONS`. Mismatch → `forged_action`.
 *   5. Allow — stamped event flows through to the parent's
 *      file-backed AuditLogger.
 *
 * Extracted into its own module so it can be unit-tested without
 * spinning up a real child process.
 */

import type { AuditEvent } from "./audit.js";
import { CHILD_PERMITTED_AUDIT_ACTIONS } from "./audit-partition.js";

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

export type AuditDecision =
  /** Rate limit exhausted — drop the event, increment the drop counter. */
  | { kind: "rate_limited" }
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
 * @param bucket Rate-limit bucket for this child.
 */
export function decideAudit(
  event: Omit<AuditEvent, "timestamp">,
  declaredPluginName: string,
  childPid: number | undefined,
  bucket: TokenBucket,
): AuditDecision {
  // 1. Rate-limit FIRST so forgery attempts also consume tokens.
  if (!bucket.consume(1)) return { kind: "rate_limited" };

  // 2. Stamp source + PID (overwriting any caller-supplied value).
  const stamped: Omit<AuditEvent, "timestamp"> = {
    ...event,
    source: "child",
    ...(childPid !== undefined ? { pid: childPid } : {}),
  };

  // 3. Plugin-identity validation.
  if (stamped.plugin !== declaredPluginName) return { kind: "forged_plugin" };

  // 4. Action-class allowlist. The Set lookup tolerates arbitrary
  //    strings — unknown actions fall through to the forgery branch.
  if (!CHILD_PERMITTED_AUDIT_ACTIONS.has(stamped.action)) return { kind: "forged_action" };

  // 5. Allow.
  return { kind: "allow", stamped };
}
