/**
 * Exclusive lock for plugin install/update/rollback/uninstall (spec §D.6).
 *
 * Implementation:
 *   - Atomic create with `O_CREAT | O_EXCL` so parallel CLI invocations fail fast.
 *   - Lock payload: { pid, command, startedAt } — used to detect stale locks.
 *   - Stale detection: `process.kill(pid, 0)` throws ESRCH when the holder is dead.
 *   - Release on process exit via `signal-exit` (covers SIGINT/SIGTERM/uncaught).
 *
 * Read-only commands (`list`, `verify`) do not acquire the lock.
 */

import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { onExit } from "signal-exit";

import { ensurePluginsRoot } from "./state.js";
import { lockFilePath } from "./paths.js";

export interface LockPayload {
  pid: number;
  command: string;
  startedAt: string;
}

export class PluginsLockedError extends Error {
  readonly code = "E_PLUGINS_LOCKED" as const;
  constructor(public readonly holder: LockPayload) {
    super(
      `Another kuzo plugins operation is running (pid ${holder.pid}, command "${holder.command}", started ${holder.startedAt}). ` +
        `Wait for it to finish, or if it has crashed, delete ${lockFilePath()} manually.`,
    );
    this.name = "PluginsLockedError";
  }
}

/**
 * Acquire the plugins lock. Returns a release function that's also wired up
 * to run on process exit so unclean exits don't leak the lock.
 *
 * Throws `PluginsLockedError` if another live process holds the lock.
 */
export function acquireLock(command: string): () => void {
  ensurePluginsRoot();
  const path = lockFilePath();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' = O_CREAT | O_EXCL | O_WRONLY — fails if the file exists.
      const fd = openSync(path, "wx");
      const payload: LockPayload = {
        pid: process.pid,
        command,
        startedAt: new Date().toISOString(),
      };
      writeFileSync(fd, JSON.stringify(payload) + "\n");
      closeSync(fd);

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(path);
        } catch {
          // Best-effort — lock dir may have been cleaned up already.
        }
      };
      // signal-exit runs the callback on any process exit path.
      onExit(release);
      return release;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;

      // Lock exists — check if the holder is still alive.
      const holder = readLockPayload(path);
      if (holder && isProcessAlive(holder.pid)) {
        throw new PluginsLockedError(holder);
      }

      // Stale — try to remove and retry once.
      try {
        unlinkSync(path);
      } catch {
        // Race: someone else cleaned it up. Retry either way.
      }
    }
  }

  // Unreachable under normal flow — two retries should always succeed.
  throw new Error(`Failed to acquire plugins lock at ${path}`);
}

function readLockPayload(path: string): LockPayload | undefined {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as LockPayload;
    if (typeof parsed.pid !== "number") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // ESRCH = no such process (stale). EPERM = exists but different owner (alive).
    return e.code === "EPERM";
  }
}
