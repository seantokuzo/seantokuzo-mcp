/**
 * Shared exclusive lock for any write to the kuzo home dir (spec §B.6 + §B.6.1).
 *
 * Phase 2.6 unifies the plugin-install lock and the credential-write lock into
 * a single canonical lock at `~/.kuzo/.lock`, so `kuzo plugins install` and
 * `kuzo credentials set` can never run concurrently.
 *
 * Implementation note: the spec's §B.6.1 sample reaches for `proper-lockfile`,
 * but the 2.5e plugin code never adopted it — it uses an `O_CREAT | O_EXCL`
 * file with `process.kill(pid, 0)` stale detection. This module keeps that
 * proven mechanism (no new dependency) and adds the spec's transition-window
 * dual-lock + typed errors on top.
 *
 * Transition (§B.6.1): a 0.0.2 CLI locks the OLD path `~/.kuzo/plugins/.lock`.
 * The 0.1.0 CLI therefore acquires BOTH the canonical lock AND the legacy lock
 * (when a plugins tree already exists) so the two versions can't clobber
 * `index.json` concurrently. Release is reverse order: legacy, then canonical.
 *
 * Read-only commands (`list`, `verify`, `status`, `test`) do NOT acquire.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { onExit } from "signal-exit";

import { kuzoHomeLockPath, pluginsRoot } from "@kuzo-mcp/core/paths";

export interface LockPayload {
  pid: number;
  command: string;
  startedAt: string;
}

/** Returned by {@link acquireFileLock} / {@link acquireKuzoLock}. */
export interface LockHandle {
  release(): Promise<void>;
}

/** A no-op handle for dry-run paths that must not touch disk. */
export const NOOP_LOCK: LockHandle = { release: async () => {} };

/** Thrown when the target lock file is held by another live process. Exit 30. */
export class LockBusyError extends Error {
  override name = "LockBusyError" as const;
  readonly code = "E_LOCK_CONTENTION" as const;
  constructor(
    public readonly lockPath: string,
    public readonly holder?: LockPayload,
  ) {
    super(
      holder
        ? `Another kuzo operation is running (pid ${holder.pid}, command "${holder.command}", started ${holder.startedAt}). ` +
            `Wait for it to finish, or if it has crashed, delete ${lockPath} manually.`
        : `Lock at ${lockPath} is held by another process.`,
    );
  }
}

/** Thrown when the legacy (pre-0.1.0) lock is held — see §B.6.1 transition. Exit 30. */
export class LockCrossVersionError extends Error {
  override name = "LockCrossVersionError" as const;
  readonly code = "E_LOCK_CROSS_VERSION" as const;
  constructor(message: string) {
    super(message);
  }
}

/** Legacy plugins lock path (pre-0.1.0): `~/.kuzo/plugins/.lock`. */
export function legacyPluginsLockPath(): string {
  return join(pluginsRoot(), ".lock");
}

/**
 * Acquire an exclusive lock at `path`. When `createParent` is true the parent
 * directory is created at mode 0700 (the canonical lock lives at the home
 * level — this is `ensureKuzoHome()` semantics). Returns a {@link LockHandle}
 * whose `release()` is also wired to run on process exit so unclean exits don't
 * leak the lock. Throws {@link LockBusyError} when a live process holds it.
 */
export async function acquireFileLock(
  path: string,
  command: string,
  createParent = true,
): Promise<LockHandle> {
  if (createParent) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

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
      const remove = (): void => {
        if (released) return;
        released = true;
        try {
          unlinkSync(path);
        } catch {
          // Best-effort — lock dir may already have been cleaned up.
        }
      };
      onExit(remove);
      return { release: async () => remove() };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;

      const holder = readLockPayload(path);
      if (holder && isProcessAlive(holder.pid)) {
        throw new LockBusyError(path, holder);
      }
      // Stale — remove and retry once.
      try {
        unlinkSync(path);
      } catch {
        // Race: another process cleaned it up. Retry either way.
      }
    }
  }
  // Unreachable under normal flow — two retries should always succeed.
  throw new Error(`Failed to acquire lock at ${path}`);
}

/**
 * Acquire the canonical kuzo-home lock, plus the legacy plugins lock during the
 * 0.0.2 → 0.1.0 transition window (§B.6.1). The legacy lock is only contended
 * for when a plugins tree already exists — creating `~/.kuzo/plugins/` purely to
 * hold a transitional lock would leak structure onto credentials-only installs.
 */
export async function acquireKuzoLock(command: string): Promise<LockHandle> {
  // 1. Canonical (new) lock — shared by plugins + credentials writes.
  const canonical = await acquireFileLock(kuzoHomeLockPath(), command);

  // 2. Legacy (old) lock — only when a pre-0.1.0 plugins tree is present.
  let legacy: LockHandle | undefined;
  if (existsSync(pluginsRoot())) {
    try {
      legacy = await acquireFileLock(legacyPluginsLockPath(), command, false);
    } catch (err) {
      await canonical.release();
      if (err instanceof LockBusyError) {
        throw new LockCrossVersionError(
          "Another kuzo process is running (possibly an older version). Wait for it to finish and retry.",
        );
      }
      throw err;
    }
  }

  return {
    release: async () => {
      if (legacy) await legacy.release();
      await canonical.release();
    },
  };
}

function readLockPayload(path: string): LockPayload | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as LockPayload;
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
