/**
 * debounce.ts — Phase 2.6 §C.11 (round-4 B8).
 *
 * A Promise-returning sleep used by the credentials directory-watch handler
 * in `runServer()`. The atomic-rename write path (tmp + rename) fires several
 * `fs.watch` events per rotation; awaiting `debounce(ms)` collapses the burst
 * into a single reload. Distinct from a bare `setTimeout` so the handler can
 * `await` it cleanly.
 */

/** Resolve after `ms` milliseconds. The timer is `unref`'d so a pending
 *  debounce never keeps the process alive on its own. */
export function debounce(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
