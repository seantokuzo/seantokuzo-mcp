/**
 * Structured audit log — JSON lines to ~/.kuzo/audit.log + stderr.
 *
 * Every security-relevant event (credential access, plugin load, consent
 * change) is recorded as a JSON line in the audit file and echoed to
 * stderr via KuzoLogger for real-time visibility.
 *
 * The CLI reads the file directly for `kuzo audit --since 7d`.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { KuzoLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditAction =
  | "credential.client_created"
  | "credential.raw_access"
  | "credential.raw_denied"
  | "credential.fetch_created"
  | "plugin.loaded"
  | "plugin.skipped"
  | "plugin.failed"
  | "consent.granted"
  | "consent.revoked"
  | "consent.checked";

export type AuditOutcome = "allowed" | "denied" | "error";

export interface AuditEvent {
  timestamp: string;
  plugin: string;
  action: AuditAction;
  outcome: AuditOutcome;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AuditLogger
// ---------------------------------------------------------------------------

export interface AuditLoggerOptions {
  /** Directory for audit.log (default: ~/.kuzo) */
  logDir?: string;
  /** Stderr logger for real-time echo */
  logger?: KuzoLogger;
}

export class AuditLogger {
  private readonly logPath: string;
  private readonly logger: KuzoLogger | undefined;

  constructor(options: AuditLoggerOptions = {}) {
    const dir = options.logDir ?? join(homedir(), ".kuzo");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.logPath = join(dir, "audit.log");
    this.logger = options.logger;
  }

  /** Record an audit event to file + stderr */
  log(event: Omit<AuditEvent, "timestamp">): void {
    const full: AuditEvent = {
      timestamp: new Date().toISOString(),
      ...event,
    };

    // Append JSON line to file
    try {
      appendFileSync(this.logPath, JSON.stringify(full) + "\n", "utf-8");
    } catch {
      // If we can't write the audit log, stderr is all we have
      this.logger?.error(`Failed to write audit log to ${this.logPath}`);
    }

    // Echo to stderr
    const tag = event.outcome === "denied" ? "[AUDIT:DENIED]" : "[AUDIT]";
    this.logger?.info(
      `${tag} ${event.action} — plugin="${event.plugin}" ${formatDetails(event.details)}`,
    );
  }

  /** Query events from the audit log file */
  query(options: {
    since?: Date;
    plugin?: string;
    action?: string;
  } = {}): AuditEvent[] {
    if (!existsSync(this.logPath)) return [];

    let raw: string;
    try {
      raw = readFileSync(this.logPath, "utf-8");
    } catch {
      this.logger?.error(`Failed to read audit log from ${this.logPath}`);
      return [];
    }
    const lines = raw.trim().split("\n").filter(Boolean);
    let events: AuditEvent[] = [];

    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as AuditEvent);
      } catch {
        // Skip malformed lines
      }
    }

    if (options.since) {
      const since = options.since.getTime();
      events = events.filter((e) => new Date(e.timestamp).getTime() >= since);
    }
    if (options.plugin) {
      events = events.filter((e) => e.plugin === options.plugin);
    }
    if (options.action) {
      events = events.filter((e) => e.action === options.action);
    }

    return events;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDetails(details: Record<string, unknown>): string {
  return Object.entries(details)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
}
