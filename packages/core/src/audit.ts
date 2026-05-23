/**
 * Structured audit log — JSON lines to `~/.kuzo/audit.log` + stderr.
 *
 * Phase 2.6 Theme 5 (spec §C.10): the parent process owns the file writer.
 * Plugin children flow audit events through IPC and are validated + stamped
 * + rate-limited in `plugin-process.ts` before reaching the
 * `FileBackedAuditLogger` here.
 *
 * Three writer surfaces, three trust boundaries:
 *   1. CLI commands (`kuzo credentials *`, `kuzo plugins *`, …) — direct.
 *   2. `runServer()` parent (boot + lifecycle + store + parent-owned
 *      PassphraseKeyProvider) — direct.
 *   3. Plugin host (every child) — `IpcAuditLogger` proxy; parent receives,
 *      validates, stamps `source: "child"` + `pid`, and writes.
 *
 * Imports of `FileBackedAuditLogger` (and `appendFile*`) are ESLint-banned
 * in `plugin-host.ts` to enforce the file-writer monopoly invariant
 * (spec §C.10 + §C.9 pattern).
 *
 * Rotation per spec §C.10.1: when `audit.log` exceeds 50 MiB the parent
 * atomically renames `audit.log` → `audit.log.1`, shifts older numbered
 * siblings down, and drops `audit.log.5`. The CLI reader globs across
 * `audit.log` + `audit.log.{1..5}` so `kuzo audit --since 30d` sees the
 * full retained window.
 */

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  statSync,
  renameSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import type { KuzoLogger } from "./logger.js";

import { kuzoHome } from "./paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditAction =
  | "credential.client_created"
  | "credential.raw_access"
  | "credential.raw_denied"
  | "credential.fetch_created"
  // Phase 2.6 Theme 2 — storage primitives. The variants below are introduced
  // here so the new code in `packages/core/src/credentials/` typechecks against
  // the closed union. Actual write-side wiring (set / deleted / rotated /
  // migrated / wiped / tested) lands with Theme 6/7 (B.1–B.3
  // commands + broker-side emissions). Spec §0 build order.
  | "credential.passphrase_consumed"
  | "credential.store_unlocked"
  | "credential.store_locked"
  // Phase 2.6 Theme 3 — env-override scrub kill-switch. Emitted by
  // `scrubProcessEnv` when KUZO_NO_ENV_SCRUB=1 (round-4 A2/B11). The
  // boot-flag --no-scrub path in §C.1 (Theme 4) reuses this action with
  // its own reason string.
  | "credential.scrub_disabled"
  | "plugin.loaded"
  | "plugin.skipped"
  | "plugin.failed"
  | "plugin.installed"
  | "plugin.uninstalled"
  | "plugin.updated"
  | "plugin.rolled_back"
  | "plugin.trust_root_refreshed"
  | "consent.granted"
  | "consent.revoked"
  | "consent.checked"
  // Phase 2.6 Theme 5 — audit IPC (spec §C.10 + §C.10.1). All four are
  // parent-only — see `audit-partition.ts`.
  | "audit.forged_plugin_field"
  | "audit.forged_action"
  | "audit.rate_limited"
  | "audit.partition_initialized";

export type AuditOutcome = "allowed" | "denied" | "error";

/**
 * Trust-boundary discriminator (spec §C.10).
 *
 * Audit consumers MUST treat a missing `source` as `"parent"` so pre-2.6
 * entries continue to parse cleanly. Only `plugin-process.handleAuditEvent`
 * stamps `"child"`; every other emitter omits the field (implicit parent)
 * or explicitly sets `"parent"` on emissions that describe child behaviour
 * (`audit.forged_*`, `audit.rate_limited`).
 */
export type AuditSource = "parent" | "child";

export interface AuditEvent {
  timestamp: string;
  plugin: string;
  action: AuditAction;
  outcome: AuditOutcome;
  details: Record<string, unknown>;
  /** Trust boundary that produced the event. Missing = `"parent"`. */
  source?: AuditSource;
  /**
   * OS process id of the writer. Present on child-stamped events and on
   * parent-emitted child-related events (rate-limit / forgery) for
   * forensic correlation. Omitted on parent emissions about the parent
   * itself.
   */
  pid?: number;
}

export interface AuditQueryFilters {
  since?: Date;
  plugin?: string;
  action?: string;
}

// ---------------------------------------------------------------------------
// AuditLogger interface
// ---------------------------------------------------------------------------

/**
 * Trust-boundary-agnostic audit logger interface (round-4 A3 split).
 *
 * Two concrete implementations live in this codebase:
 *   - `FileBackedAuditLogger` (this file) — parent-side writer.
 *   - `IpcAuditLogger` (`plugin-host.ts`) — child-side proxy that notifies
 *     the parent over IPC.
 */
export interface AuditLogger {
  log(event: Omit<AuditEvent, "timestamp">): void;
  query(filters?: AuditQueryFilters): AuditEvent[];
}

// ---------------------------------------------------------------------------
// FileBackedAuditLogger
// ---------------------------------------------------------------------------

export interface AuditLoggerOptions {
  /** Directory for `audit.log`. Defaults to `kuzoHome()` (usually `~/.kuzo`). */
  logDir?: string;
  /** Stderr logger for real-time echo */
  logger?: KuzoLogger;
}

// Rotation policy per spec §C.10.1.
const ROTATE_THRESHOLD_BYTES = 50 * 1024 * 1024;
const RETAIN_ROTATED_COUNT = 5;
// stat() cost amortizer — only check the file size every Nth log() call.
const WRITES_BETWEEN_ROTATE_CHECKS = 100;

/**
 * Default file-backed AuditLogger.
 *
 * The ONLY consumer of `appendFileSync` / `readFileSync` against
 * `audit.log` in the runtime. `plugin-host.ts` (child) MUST NOT import
 * this class — see the ESLint guard in `eslint.config.js`.
 */
export class FileBackedAuditLogger implements AuditLogger {
  private readonly logPath: string;
  private readonly logger: KuzoLogger | undefined;
  private writesSinceLastStat = 0;

  constructor(options: AuditLoggerOptions = {}) {
    const dir = options.logDir ?? kuzoHome();
    if (!existsSync(dir)) {
      // mode: 0o700 matches the 0o600 we set on `audit.log` itself —
      // both should be unreadable by other users on the host. Without
      // this, mkdirSync uses the process umask (typically 0o755 =
      // world-readable). Round-2 Security advisory.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    this.logPath = join(dir, "audit.log");
    this.logger = options.logger;
  }

  /**
   * Record an audit event to file + stderr.
   *
   * Never-throw contract (round-2 Correctness): audit emission must never
   * break the operation that triggered it. Both the file write and the
   * stderr echo route through `safeStringify`, which catches BigInt /
   * circular details and falls back to a `"[unserializable]"` placeholder.
   */
  log(event: Omit<AuditEvent, "timestamp">): void {
    const full: AuditEvent = {
      timestamp: new Date().toISOString(),
      ...event,
    };

    try {
      // `mode: 0o600` applies only when appendFileSync creates the file
      // (i.e. on first ever write). Keeps audit.log unreadable by other
      // users on the host out of the box.
      appendFileSync(this.logPath, safeStringify(full) + "\n", { mode: 0o600 });
    } catch {
      this.logger?.error(`Failed to write audit log to ${this.logPath}`);
    }

    // Amortize the stat cost — check file size every Nth write only.
    if (++this.writesSinceLastStat >= WRITES_BETWEEN_ROTATE_CHECKS) {
      this.writesSinceLastStat = 0;
      this.maybeRotate();
    }

    // The stderr echo's `details` content can originate in an untrusted
    // child (post-Theme-5 IPC routing). `safeStringify` escapes control
    // bytes the same way the file write does and tolerates BigInt /
    // circular references — round-1 + round-3 Security advisories.
    const tag = event.outcome === "denied" ? "[AUDIT:DENIED]" : "[AUDIT]";
    this.logger?.info(
      `${tag} ${event.action} — plugin=${safeStringify(event.plugin)} details=${safeStringify(event.details)}`,
    );
  }

  /**
   * Query events from `audit.log` plus rotated `audit.log.{1..N}` siblings
   * (spec §C.10.1). Rotated files contain older entries — we concat
   * highest-numbered first so the returned events are in approximate
   * chronological order. A crash mid-rotation can leave numbering gaps;
   * `existsSync` guards each file and missing slots are simply skipped.
   */
  query(filters: AuditQueryFilters = {}): AuditEvent[] {
    let events: AuditEvent[] = [];

    // Oldest → newest: audit.log.5, .4, .3, .2, .1, then current audit.log.
    for (let i = RETAIN_ROTATED_COUNT; i >= 1; i--) {
      events = events.concat(this.readFile(`${this.logPath}.${i}`));
    }
    events = events.concat(this.readFile(this.logPath));

    if (filters.since) {
      const since = filters.since.getTime();
      events = events.filter((e) => new Date(e.timestamp).getTime() >= since);
    }
    if (filters.plugin) {
      events = events.filter((e) => e.plugin === filters.plugin);
    }
    if (filters.action) {
      events = events.filter((e) => e.action === filters.action);
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private readFile(path: string): AuditEvent[] {
    if (!existsSync(path)) return [];
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      this.logger?.error(`Failed to read audit log from ${path}`);
      return [];
    }
    const lines = raw.trim().split("\n").filter(Boolean);
    const events: AuditEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as AuditEvent);
      } catch {
        // Skip malformed lines
      }
    }
    return events;
  }

  /**
   * Atomic rotation when `audit.log` exceeds `ROTATE_THRESHOLD_BYTES`
   * (spec §C.10.1). Per-file rename only — no copy — so concurrent
   * readers (`kuzo audit --since 7d`) see consistent files even
   * mid-rotation. A crash mid-rotation can leave numbering gaps; the
   * `query()` reader tolerates missing files via `existsSync`.
   */
  private maybeRotate(): void {
    let size: number;
    try {
      size = statSync(this.logPath).size;
    } catch {
      return;
    }
    if (size < ROTATE_THRESHOLD_BYTES) return;

    // Drop the oldest, shift everyone else down by one (high → low).
    for (let i = RETAIN_ROTATED_COUNT; i >= 1; i--) {
      const src = `${this.logPath}.${i}`;
      const dst = `${this.logPath}.${i + 1}`;
      if (!existsSync(src)) continue;
      if (i === RETAIN_ROTATED_COUNT) {
        try {
          unlinkSync(src);
        } catch {
          this.logger?.error(`Failed to unlink ${src} during rotation`);
        }
      } else {
        try {
          renameSync(src, dst);
        } catch {
          this.logger?.error(`Failed to rename ${src} → ${dst} during rotation`);
        }
      }
    }
    try {
      renameSync(this.logPath, `${this.logPath}.1`);
    } catch {
      this.logger?.error(`Failed to rotate ${this.logPath} → ${this.logPath}.1`);
    }
    // Next log() recreates audit.log via appendFileSync's create-if-missing.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safe JSON.stringify — round-3 Security advisory. Falls back to a
 * placeholder string when the input contains BigInts, circular refs,
 * or anything else that throws. Used by both the file write and the
 * stderr echo so neither can violate the never-throw contract.
 */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '"[unserializable]"';
  }
}

