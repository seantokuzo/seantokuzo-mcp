/**
 * PluginProcess — parent-side manager for a single plugin child process.
 *
 * Handles lazy spawn, tool call proxying, crash recovery with exponential
 * backoff, heartbeat monitoring, and scoped env var injection.
 */

import { fork, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { IpcChannel } from "./ipc.js";
import type { DeclaredCredentialCapabilities } from "./credentials/index.js";
import type { KuzoLogger } from "./logger.js";
import type { PluginRegistry } from "./registry.js";
import type { AuditEvent, AuditLogger } from "./audit.js";
import {
  AUDIT_WIRE_MAX_BYTES,
  decideAudit,
  isAuditWireEvent,
  TokenBucket,
  withinAuditByteCap,
} from "./audit-ipc.js";

import { assertNoFsArgInjection, kuzoHome } from "./paths.js";

/**
 * Child-process entry. Resolved through the core package's exports map so the
 * path is correct in both dev (pnpm symlink) and installed mode. fork() wants
 * a filesystem path, not a URL — fileURLToPath unwraps it.
 */
const HOST_PATH = fileURLToPath(import.meta.resolve("@kuzo-mcp/core/plugin-host"));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Backoff delays for crash recovery (ms) */
const BACKOFF_DELAYS = [0, 500, 2_000, 8_000, 30_000];

/** Max restarts before marking plugin degraded */
const MAX_RESTARTS = 5;

/** Window for counting restarts (5 min) */
const RESTART_WINDOW_MS = 5 * 60 * 1_000;

/** Reset restart count after stable for this long */
const STABLE_RESET_MS = 60_000;

/** Heartbeat interval */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Heartbeat timeout — kill if no pong within this */
const HEARTBEAT_TIMEOUT_MS = 5_000;

/** Graceful shutdown timeout before SIGTERM */
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** SIGTERM → SIGKILL escalation timeout */
const SIGKILL_TIMEOUT_MS = 3_000;

/** Tool call timeout */
const TOOL_CALL_TIMEOUT_MS = 120_000;

/** Initialize timeout */
const INIT_TIMEOUT_MS = 30_000;

/** Max heap per child */
const MAX_OLD_SPACE_MB = 256;

// ---------------------------------------------------------------------------
// Audit IPC rate-limit policy (spec §C.10.1)
// ---------------------------------------------------------------------------
//
// Per-child token bucket sized at 200 burst / 100 refill-per-sec. Excess
// child audit events are DROPPED (not queued); drops are counted and
// surfaced via a parent-side `audit.rate_limited` event at most once per
// second. The decision logic + TokenBucket live in `audit-ipc.ts` so
// they can be unit-tested without spawning a real child process.

const AUDIT_BUCKET_CAPACITY = 200;
const AUDIT_BUCKET_REFILL_PER_SEC = 100;
const RATE_LIMIT_REPORT_INTERVAL_MS = 1_000;

// ---------------------------------------------------------------------------
// System env vars to forward to every child
// ---------------------------------------------------------------------------

function getSystemEnv(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of ["PATH", "LANG", "TERM", "NODE_ENV", "HOME", "DEBUG"]) {
    const val = process.env[key];
    if (val !== undefined) vars[key] = val;
  }
  return vars;
}

// ---------------------------------------------------------------------------
// PluginProcess
// ---------------------------------------------------------------------------

export type PluginProcessState = "idle" | "spawning" | "ready" | "degraded" | "shutdown";

export class PluginProcess {
  private child: ChildProcess | null = null;
  private channel: IpcChannel | null = null;
  private state: PluginProcessState = "idle";

  // Crash recovery
  private restartCount = 0;
  private restartTimestamps: number[] = [];
  private stableTimer: NodeJS.Timeout | null = null;

  // Heartbeat
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // In-flight tool calls — heartbeat skips while > 0 (sync work blocks pong)
  private inFlightCalls = 0;

  // Pending callers waiting for spawn
  private spawnPromise: Promise<void> | null = null;

  // Audit IPC rate-limit state (spec §C.10.1)
  private readonly auditBucket = new TokenBucket(
    AUDIT_BUCKET_CAPACITY,
    AUDIT_BUCKET_REFILL_PER_SEC,
  );
  private rateLimitedSinceReport = 0;
  private lastRateLimitReportAt = 0;
  // Round-1 Observability advisory: a burst that ends mid-window would
  // otherwise lose the trailing drop count until the next drop arrives.
  // This timer guarantees the trailing count is flushed within one
  // interval of the last drop.
  private rateLimitTrailingTimer: NodeJS.Timeout | null = null;

  // Captured child PID for audit forensic stamping. Cleared in cleanup() so
  // notifications that race the exit handler can't stamp a stale PID.
  private childPid: number | undefined;

  constructor(
    private readonly pluginName: string,
    /** file:// URL of the plugin's module entry — resolved by plugin-resolver */
    private readonly pluginEntryUrl: string,
    /** Scoped credential env (cred names → values). Mutable: `refreshCredentials`
     *  swaps it on rotation so lazy/respawn forks use fresh values (§C.11). */
    private scopedEnv: Record<string, string>,
    /**
     * Declared credential capabilities split required-vs-optional (spec §C.11).
     * The flat list the child broker consumes is derived at spawn; the parent
     * watcher re-resolves creds against this split via
     * `CredentialSource.extractForPlugin(proc.declaredCapabilities)`.
     */
    readonly declaredCapabilities: DeclaredCredentialCapabilities,
    /** Cross-plugin deps. null = unrestricted (V1 legacy). Set = scoped to declared deps (V2). */
    private readonly declaredDeps: Set<string> | null,
    private readonly logger: KuzoLogger,
    private readonly registry: PluginRegistry,
    private readonly auditLogger: AuditLogger,
  ) {}

  /** Current process state */
  getState(): PluginProcessState {
    return this.state;
  }

  // -------------------------------------------------------------------------
  // Spawn
  // -------------------------------------------------------------------------

  /**
   * Ensure the child process is running. Lazy — first call spawns it.
   * Concurrent callers share the same spawn promise.
   */
  async ensureRunning(): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "degraded") {
      throw new Error(`Plugin "${this.pluginName}" is degraded — too many crashes. Restart the server.`);
    }
    if (this.state === "shutdown") {
      throw new Error(`Plugin "${this.pluginName}" is shutting down`);
    }

    // Coalesce concurrent spawn requests
    if (this.spawnPromise) return this.spawnPromise;
    this.spawnPromise = this.spawn();

    try {
      await this.spawnPromise;
    } finally {
      this.spawnPromise = null;
    }
  }

  private async spawn(): Promise<void> {
    this.state = "spawning";
    this.logger.info(`Spawning child process for "${this.pluginName}"`);

    const env: Record<string, string> = {
      ...getSystemEnv(),
      ...this.scopedEnv,
    };

    const execArgv = [`--max-old-space-size=${MAX_OLD_SPACE_MB}`];

    // Optional Node Permission Model flags
    if (process.env["KUZO_NODE_PERMISSIONS"] === "true") {
      const pluginFsPath = fileURLToPath(this.pluginEntryUrl);
      // Both arms of the comma-delimited --allow-fs-read= arg must be free of
      // characters that would inject extra paths. `kuzoHome()` self-validates,
      // but `pluginFsPath` ultimately comes from a plugin's package name via
      // import.meta.resolve and could in principle contain a comma on a
      // filesystem that allows them — assert here so the sandbox boundary is
      // never widened by a hostile path. (Round-2 Security advisory.)
      assertNoFsArgInjection(pluginFsPath, "pluginFsPath");
      execArgv.push(
        "--experimental-permission",
        // Trailing slash is intentional: Node's --allow-fs-read distinguishes
        // recursive folder access (`/dir/`) from single-inode access (`/dir`).
        // Plugins read audit.log / consent.json / etc. under kuzoHome — need
        // recursive.
        `--allow-fs-read=${pluginFsPath},${kuzoHome()}/`,
      );
      this.logger.info(`Node Permission Model enabled for "${this.pluginName}"`);
    }

    this.child = fork(HOST_PATH, [], {
      env,
      execArgv,
      serialization: "json",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    // Capture PID immediately so audit notifications arriving during init
    // stamp the correct child PID.
    this.childPid = this.child.pid;

    // Pipe child stderr to parent stderr (for direct writes like uncaught exceptions)
    this.child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    // Create IPC channel
    this.channel = new IpcChannel(this.child);

    // Handle cross-plugin callTool requests from child.
    // V2 plugins: scoped to declared deps. V1 (declaredDeps=null): unrestricted.
    this.channel.onRequest(async (method, params) => {
      if (method === "callTool") {
        const { toolName, args } = params as { toolName: string; args: Record<string, unknown> };
        const entry = this.registry.findTool(toolName);
        if (!entry) {
          throw new Error(`Tool "${toolName}" not found`);
        }
        if (this.declaredDeps !== null && !this.declaredDeps.has(entry.plugin.name)) {
          throw new Error(`Tool "${toolName}" not found`);
        }
        return this.registry.callTool(toolName, args);
      }
      throw new Error(`Unknown request from child: ${method}`);
    });

    // Handle notifications from child (log + audit)
    this.channel.onNotification((method, params) => {
      if (method === "log") {
        const { level, message, data, plugin } = params as {
          level: string;
          message: string;
          data?: unknown;
          plugin: string;
        };
        const logFn = this.logger[level as keyof KuzoLogger];
        if (typeof logFn === "function") {
          (logFn as (msg: string, data?: unknown) => void).call(this.logger, `[${plugin}] ${message}`, data);
        }
        return;
      }
      if (method === "audit") {
        // Spec §C.10 — the parent owns the audit file writer; child IPC
        // emissions flow through the rate-limit + wire-validation +
        // identity + action-class allowlist gauntlet before reaching
        // the AuditLogger.
        //
        // Rate-limit FIRST (round-3 Security advisory): consume from
        // the bucket BEFORE wire validation so malformed / oversize /
        // forged frames cannot bypass the limit and spam logger.warn
        // at IPC line rate.
        if (!this.auditBucket.consume(1)) {
          this.rateLimitedSinceReport++;
          this.reportRateLimitIfDue(this.childPid);
          return;
        }
        const event = (params as { event?: unknown } | null)?.event;
        if (!isAuditWireEvent(event)) {
          this.logger.warn(
            `Dropped malformed audit notification from "${this.pluginName}" — wire shape invalid`,
          );
          return;
        }
        if (!withinAuditByteCap(event)) {
          this.logger.warn(
            `Dropped oversize audit notification from "${this.pluginName}" — payload exceeds ${AUDIT_WIRE_MAX_BYTES} bytes`,
          );
          return;
        }
        // Defense-in-depth — round-4 Correctness advisory. The
        // `FileBackedAuditLogger.log` and `decideAudit` paths already
        // never throw, but wrap the whole handler so any future writer
        // added under handleAuditEvent doesn't quietly break IPC if it
        // forgets the contract.
        try {
          this.handleAuditEvent(event);
        } catch (err) {
          this.logger.error(
            `handleAuditEvent threw for "${this.pluginName}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }
    });

    // Handle unexpected exit
    this.child.on("exit", (code, signal) => {
      if (this.state === "shutdown") return; // Intentional shutdown
      this.logger.warn(`Child "${this.pluginName}" exited (code=${code}, signal=${signal})`);
      this.cleanup();
      this.scheduleRestart();
    });

    // Send initialize request
    try {
      await this.channel.request(
        "initialize",
        {
          pluginName: this.pluginName,
          pluginEntryUrl: this.pluginEntryUrl,
          env,
          capabilities: [
            ...this.declaredCapabilities.required,
            ...this.declaredCapabilities.optional,
          ],
        },
        INIT_TIMEOUT_MS,
      );
    } catch (err) {
      this.logger.error(
        `Failed to initialize "${this.pluginName}" in child process`,
        err instanceof Error ? err.message : err,
      );
      this.kill();
      throw err;
    }

    this.state = "ready";
    this.startHeartbeat();
    this.startStableTimer();

    this.logger.info(`Child process for "${this.pluginName}" is ready (pid=${this.child.pid})`);

    this.auditLogger.log({
      plugin: this.pluginName,
      action: "plugin.loaded",
      outcome: "allowed",
      details: { pid: this.child.pid, isolated: true },
    });
  }

  // -------------------------------------------------------------------------
  // Tool calls
  // -------------------------------------------------------------------------

  /** Forward a tool call to the child process */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureRunning();

    if (!this.channel) {
      throw new Error(`No IPC channel for "${this.pluginName}"`);
    }

    this.inFlightCalls++;
    try {
      return await this.channel.request("callTool", { toolName, args }, TOOL_CALL_TIMEOUT_MS);
    } finally {
      this.inFlightCalls--;
    }
  }

  /** Forward a resource read to the child process */
  async readResource(uri: string): Promise<string> {
    await this.ensureRunning();

    if (!this.channel) {
      throw new Error(`No IPC channel for "${this.pluginName}"`);
    }

    return this.channel.request<string>("readResource", { uri }, TOOL_CALL_TIMEOUT_MS);
  }

  // -------------------------------------------------------------------------
  // Credential refresh (spec §C.11 — rotation cache invalidation)
  // -------------------------------------------------------------------------

  /**
   * Replace this plugin's scoped credentials after an on-disk rotation.
   *
   * Two halves:
   *   1. Update the stored `scopedEnv` so a not-yet-spawned (lazy) child and
   *      any future crash-respawn boot with the rotated values. `config` is
   *      credentials only; `spawn()` re-merges `getSystemEnv()` on each fork.
   *   2. If the child is live (`ready`), push the new Map over IPC so the
   *      running broker swaps its config + clears its client cache without a
   *      restart (fire-and-forget — `plugin-host` handles `credential.refresh`).
   *
   * The scopedEnv update is the parent-side half the spec's notify-only
   * snippet omits — without it an idle plugin would spawn stale after a
   * rotation. Limitation per §C.11/§F.4: a plugin that stashed a client in
   * its own state (not via `getClient` each call) keeps the old token until
   * its client is rebuilt; first-party plugins go through `getClient` so they
   * pick up the rotation on the next tool call.
   */
  refreshCredentials(config: Map<string, string>): void {
    this.scopedEnv = Object.fromEntries(config);
    if (this.channel && this.state === "ready") {
      this.channel.notify("credential.refresh", { config: this.scopedEnv });
    }
  }

  // -------------------------------------------------------------------------
  // Audit IPC (spec §C.10 + §C.10.1)
  // -------------------------------------------------------------------------
  //
  // Rate-limit + wire-shape + byte-cap gating happens in the notification
  // handler above (round-3 Security advisory — rate-limit FIRST so every
  // shape of frame counts toward the bucket). By the time this method
  // runs, the event has passed all three gates. The gauntlet here is:
  //   1. PID + source stamp (overwrites any caller-supplied value).
  //   2. Plugin-identity validation — `event.plugin` must equal this
  //      child's declared plugin name. Mismatch → `audit.forged_plugin_field`,
  //      original event DROPPED.
  //   3. Action-class allowlist — `event.action` must be a member of
  //      `CHILD_PERMITTED_AUDIT_ACTIONS`. Else → `audit.forged_action`,
  //      original DROPPED.
  //   4. Trusted-path forward to the parent's file-backed AuditLogger.

  private handleAuditEvent(event: Omit<AuditEvent, "timestamp">): void {
    const childPid = this.childPid;
    const decision = decideAudit(event, this.pluginName, childPid);

    switch (decision.kind) {
      case "forged_plugin":
        this.auditLogger.log({
          plugin: "kuzo",
          action: "audit.forged_plugin_field",
          outcome: "denied",
          source: "parent",
          ...(childPid !== undefined ? { pid: childPid } : {}),
          details: {
            claimed_plugin: event.plugin,
            actual_plugin: this.pluginName,
            child_pid: childPid,
            attempted_action: event.action,
          },
        });
        return;

      case "forged_action":
        // Spec round-4 nit N3: don't embed `permitted` here — the
        // `audit.partition_initialized` boot event covers it exactly
        // once per server lifetime, and per-entry duplication pollutes
        // the log.
        this.auditLogger.log({
          plugin: "kuzo",
          action: "audit.forged_action",
          outcome: "denied",
          source: "parent",
          ...(childPid !== undefined ? { pid: childPid } : {}),
          details: {
            plugin: this.pluginName,
            child_pid: childPid,
            attempted_action: event.action,
          },
        });
        return;

      case "allow":
        this.auditLogger.log(decision.stamped);
        return;
    }
  }

  private reportRateLimitIfDue(childPid: number | undefined): void {
    const now = Date.now();
    if (now - this.lastRateLimitReportAt >= RATE_LIMIT_REPORT_INTERVAL_MS) {
      // Window elapsed — emit immediately.
      this.flushRateLimitDrops(childPid);
      return;
    }
    // Window still open — make sure a trailing flush is queued so the
    // accumulated drops aren't lost if the burst ends mid-window
    // (round-1 Observability advisory).
    this.scheduleTrailingRateLimitFlush();
  }

  private flushRateLimitDrops(childPid: number | undefined): void {
    if (this.rateLimitedSinceReport === 0) return;
    this.auditLogger.log({
      plugin: "kuzo",
      action: "audit.rate_limited",
      outcome: "denied",
      source: "parent",
      ...(childPid !== undefined ? { pid: childPid } : {}),
      details: {
        plugin: this.pluginName,
        child_pid: childPid,
        drops_in_window: this.rateLimitedSinceReport,
      },
    });
    this.lastRateLimitReportAt = Date.now();
    this.rateLimitedSinceReport = 0;
  }

  private scheduleTrailingRateLimitFlush(): void {
    if (this.rateLimitTrailingTimer !== null) return;
    // Aim to fire RATE_LIMIT_REPORT_INTERVAL_MS after the LAST emit, but
    // never less than 50ms to avoid a no-op tight loop when the interval
    // is already past.
    const elapsed = Date.now() - this.lastRateLimitReportAt;
    const delayMs = Math.max(50, RATE_LIMIT_REPORT_INTERVAL_MS - elapsed);
    this.rateLimitTrailingTimer = setTimeout(() => {
      this.rateLimitTrailingTimer = null;
      this.flushRateLimitDrops(this.childPid);
    }, delayMs);
    this.rateLimitTrailingTimer.unref();
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.ping();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async ping(): Promise<void> {
    if (!this.channel || this.state !== "ready") return;

    // Skip heartbeat while tool calls are in-flight — sync work (e.g. execSync
    // in git-context) blocks the child event loop, preventing pong responses.
    if (this.inFlightCalls > 0) return;

    try {
      await this.channel.request("ping", undefined, HEARTBEAT_TIMEOUT_MS);
    } catch {
      this.logger.error(`Heartbeat failed for "${this.pluginName}" — killing unresponsive child`);
      this.kill();
      // exit handler will trigger restart
    }
  }

  // -------------------------------------------------------------------------
  // Crash recovery
  // -------------------------------------------------------------------------

  private scheduleRestart(): void {
    const now = Date.now();
    this.restartTimestamps.push(now);

    // Prune timestamps outside the restart window
    this.restartTimestamps = this.restartTimestamps.filter(
      (ts) => now - ts < RESTART_WINDOW_MS,
    );

    if (this.restartTimestamps.length >= MAX_RESTARTS) {
      this.logger.error(
        `Plugin "${this.pluginName}" crashed ${MAX_RESTARTS} times in ${RESTART_WINDOW_MS / 60_000} min — marking degraded`,
      );
      this.state = "degraded";
      this.auditLogger.log({
        plugin: this.pluginName,
        action: "plugin.failed",
        outcome: "error",
        details: { reason: "degraded — max restarts exceeded" },
      });
      return;
    }

    const delay = BACKOFF_DELAYS[Math.min(this.restartCount, BACKOFF_DELAYS.length - 1)] ?? 30_000;
    this.restartCount++;

    this.logger.info(`Restarting "${this.pluginName}" in ${delay}ms (attempt ${this.restartCount})`);

    setTimeout(() => {
      if (this.state === "shutdown" || this.state === "degraded") return;
      void this.ensureRunning().catch((err) => {
        this.logger.error(`Restart of "${this.pluginName}" failed`, err instanceof Error ? err.message : err);
      });
    }, delay).unref();
  }

  private startStableTimer(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      if (this.state === "ready") {
        this.restartCount = 0;
        this.restartTimestamps = [];
        this.logger.debug(`"${this.pluginName}" stable for ${STABLE_RESET_MS / 1000}s — reset restart count`);
      }
    }, STABLE_RESET_MS);
    this.stableTimer.unref();
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  /** Graceful shutdown: IPC request → timeout → SIGTERM → SIGKILL */
  async shutdown(): Promise<void> {
    if (this.state === "shutdown") return;
    this.state = "shutdown";
    this.stopHeartbeat();
    this.clearStableTimer();

    if (!this.child || !this.channel) {
      this.cleanup();
      return;
    }

    // Try graceful shutdown via IPC
    try {
      await this.channel.request("shutdown", undefined, SHUTDOWN_TIMEOUT_MS);
    } catch {
      this.logger.warn(`"${this.pluginName}" did not respond to shutdown — sending SIGTERM`);
    }

    // Wait for the child to exit, escalate if needed
    if (this.child.exitCode === null && !this.child.killed) {
      this.child.kill("SIGTERM");

      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          if (this.child && this.child.exitCode === null) {
            this.logger.warn(`"${this.pluginName}" did not exit after SIGTERM — sending SIGKILL`);
            this.child.kill("SIGKILL");
          }
          resolve();
        }, SIGKILL_TIMEOUT_MS);
        killTimer.unref();

        this.child?.on("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }

    this.cleanup();
    this.logger.info(`Child process for "${this.pluginName}" shut down`);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private kill(): void {
    if (this.child && this.child.exitCode === null) {
      this.child.kill("SIGKILL");
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.stopHeartbeat();
    this.clearStableTimer();
    // Round-1 Observability advisory: drain any trailing rate-limit
    // drops before the PID is cleared, so the forgery / drop forensics
    // for this child generation are complete. Cancel the pending
    // trailing timer (we're flushing manually) and force-emit by
    // zeroing `lastRateLimitReportAt`.
    if (this.rateLimitTrailingTimer) {
      clearTimeout(this.rateLimitTrailingTimer);
      this.rateLimitTrailingTimer = null;
    }
    if (this.rateLimitedSinceReport > 0) {
      // `flushRateLimitDrops` only gates on `rateLimitedSinceReport > 0`,
      // not on `lastRateLimitReportAt` — so a prior version's "force-emit
      // by zeroing lastRateLimitReportAt" line was dead code (round-3
      // Correctness advisory). The flush happens unconditionally here.
      this.flushRateLimitDrops(this.childPid);
    }
    this.channel?.close();
    this.channel = null;
    this.child = null;
    // Clear the cached child PID so audit notifications that race the
    // exit handler can't stamp a stale value.
    this.childPid = undefined;
    if (this.state !== "shutdown" && this.state !== "degraded") {
      this.state = "idle";
    }
  }
}
