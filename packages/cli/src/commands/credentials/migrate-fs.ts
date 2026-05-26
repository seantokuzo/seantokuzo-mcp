/**
 * Symlink-safe source I/O for `kuzo credentials migrate` (spec §B.4 R18/R19).
 *
 * Migrate NEVER follows a symlink — the canonical path is the only legal target
 * — and it NEVER leaves a `.bak` (a forgotten plaintext copy is the leak we're
 * preventing). Reads are guarded at three independent points so a swap between
 * `lstat` and `open` can't smuggle a different inode in:
 *
 *   1. `lstat`  → reject a symlink (`E_SYMLINK_REFUSE` / 74) or non-regular file
 *                 (`E_NOT_REGULAR_FILE` / 75).
 *   2. `open`   → `O_NOFOLLOW` so a path swapped to a symlink fails with ELOOP.
 *   3. `fstat`  → the opened fd's (`dev`,`ino`) must equal the `lstat` result.
 *
 * Writes go through a tmp + `fsync` + `rename` + directory-`fsync` so the
 * replacement is atomic and durable.
 */

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { CredentialsCliError } from "./errors.js";

/** `O_NOFOLLOW` where the platform defines it (POSIX); 0 (no-op) on Windows. */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export function symlinkRefuseError(path: string): CredentialsCliError {
  return new CredentialsCliError(
    "E_SYMLINK_REFUSE",
    `Refusing to migrate ${path}: it is a symlink. Migrate only operates on a real, ` +
      `non-symlinked file. Replace the symlink with the real file (or edit the target directly) and retry.`,
  );
}

export function notRegularFileError(path: string): CredentialsCliError {
  return new CredentialsCliError(
    "E_NOT_REGULAR_FILE",
    `Refusing to migrate ${path}: it is not a regular file (directory, FIFO, socket, or device).`,
  );
}

export function sourceMutatedError(path: string): CredentialsCliError {
  return new CredentialsCliError(
    "E_SOURCE_MUTATED",
    `The source file ${path} was modified during migration; close your editor and retry. ` +
      `Already-imported credentials remain in the store; re-running \`kuzo credentials migrate\` is safe ` +
      `(already-stored matching values are skipped).`,
  );
}

/**
 * Read a source file with the full symlink-safe guard. Returns the file's bytes
 * (the content snapshot used for the editor-collision byte-compare). Throws
 * `E_SYMLINK_REFUSE` / `E_NOT_REGULAR_FILE` on a refused path.
 */
export function safeReadSource(path: string): Buffer {
  const linkStat = lstatSync(path);
  if (linkStat.isSymbolicLink()) throw symlinkRefuseError(path);
  if (!linkStat.isFile()) throw notRegularFileError(path);

  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    // ELOOP: the path became a symlink between lstat and open (TOCTOU).
    if ((err as NodeJS.ErrnoException).code === "ELOOP") throw symlinkRefuseError(path);
    throw err;
  }
  try {
    const openStat = fstatSync(fd);
    if (openStat.dev !== linkStat.dev || openStat.ino !== linkStat.ino) {
      throw symlinkRefuseError(path); // file swapped under us between lstat and open
    }
    if (!openStat.isFile()) throw notRegularFileError(path);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Re-read `path` (same guards as {@link safeReadSource}) and assert it is still
 * byte-identical to `snapshot`. Throws `E_SOURCE_MUTATED` (76) if it changed —
 * the user's editor takes precedence; migrate never clobbers a concurrent edit.
 */
export function assertSourceUnchanged(path: string, snapshot: Buffer): void {
  const current = safeReadSource(path);
  if (Buffer.compare(current, snapshot) !== 0) throw sourceMutatedError(path);
}

/**
 * Atomically replace `path` with `content`: write `<path>.tmp` (O_NOFOLLOW,
 * mode 0600), `fsync` it, `rename` over the target, then `fsync` the containing
 * directory so the rename is durable. No `.bak` file.
 */
export function atomicRewriteSource(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(
    tmp,
    constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDirectory(dirname(path));
}

/** Best-effort `fsync` of a directory fd so a rename within it hits disk. */
function fsyncDirectory(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, constants.O_RDONLY);
  } catch {
    return; // Windows / restricted dirs can't open a dir fd; durability is best-effort.
  }
  try {
    fsyncSync(fd);
  } catch {
    /* best-effort */
  } finally {
    closeSync(fd);
  }
}
