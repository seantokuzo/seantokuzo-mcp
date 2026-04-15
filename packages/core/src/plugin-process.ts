/**
 * PluginProcess — parent-side manager for a single plugin child process.
 *
 * Handles lazy spawn, tool call proxying, crash recovery with exponential
 * backoff, heartbeat monitoring, and scoped env var injection.
 */

import { fork, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { IpcChannel } from "./ipc.js";
import type { CredentialCapability } from "@kuzo-mcp/types";
import type { KuzoLogger } from "./logger.js";
import type { PluginRegistry } from "./registry.js";
import type { AuditLogger } from "./audit.js";

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

  constructor(
    private readonly pluginName: string,
    /** file:// URL of the plugin's module entry — resolved by plugin-resolver */
    private readonly pluginEntryUrl: string,
    private readonly scopedEnv: Record<string, string>,
    private readonly capabilities: CredentialCapability[],
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
      execArgv.push(
        "--experimental-permission",
        `--allow-fs-read=${pluginFsPath},${homedir()}/.kuzo/`,
      );
      this.logger.info(`Node Permission Model enabled for "${this.pluginName}"`);
    }

    this.child = fork(HOST_PATH, [], {
      env,
      execArgv,
      serialization: "json",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });

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

    // Handle notifications from child (log messages)
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
          capabilities: this.capabilities,
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
    this.channel?.close();
    this.channel = null;
    this.child = null;
    if (this.state !== "shutdown" && this.state !== "degraded") {
      this.state = "idle";
    }
  }
}
