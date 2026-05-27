/**
 * Pure source-file redaction for `kuzo credentials migrate` (spec §B.4 step 3).
 *
 * Both formats parse → drop → re-emit; NEITHER line-strips. A line-strip would
 * leave the orphaned second line of a multi-line quoted value on disk in
 * cleartext (brief vector 3 — the exact leak migrate exists to prevent).
 *
 *   - `.env`        — `dotenv.parse` is the authoritative key set; the rewrite
 *                     keeps every non-dropped entry VERBATIM (preserving its
 *                     `export` prefix and original quoting) and removes the full
 *                     physical line range of each dropped entry. A quote-aware
 *                     extent scanner finds multi-line quoted values so a dropped
 *                     value's continuation lines never survive.
 *   - `settings.json` — `JSON.parse` → delete the dropped keys from every kuzo
 *                     `mcpServers` entry's `env` block → `JSON.stringify` with
 *                     the source's detected indent.
 *
 * `verify*Redaction` re-parses the rewritten bytes with the SAME parser the
 * loader uses at boot and reports any surviving credential NAME (spec §B.4 3.d).
 * The `.env` verifier adds a value-fragment substring backstop — the §F.1 "no
 * fragment of the quoted-value second line" acceptance, which a name-only check
 * cannot catch if a multi-line extent were miscomputed. The settings.json
 * verifier does NOT: JSON can't orphan a fragment, and a value legitimately
 * shared with a non-kuzo MCP server must not be treated as a leak.
 */

import { parse as parseDotenv } from "dotenv";

import { isKuzoMcpEntry } from "./migrate-discovery.js";

/** A surviving piece of a credential the rewrite was supposed to remove. */
export interface RedactionLeak {
  /** `name` — the key is still parseable; `fragment` — a value line survives. */
  kind: "name" | "fragment";
  name: string;
}

/**
 * Below this length a dropped value's line is too short to assert against
 * without risking a false-positive collision with legitimately-kept config.
 * Real credential material is long + high-entropy, so this only excludes
 * pathological one- or two-char values.
 */
const FRAGMENT_MIN_LEN = 8;

// ─── .env ─────────────────────────────────────────────────────────────────

/** Rewrite `.env` content with `dropKeys` removed; everything else verbatim. */
export function redactDotenv(raw: string, dropKeys: ReadonlySet<string>): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const key = matchAssignmentKey(line);
    if (key === undefined) {
      out.push(line);
      i += 1;
      continue;
    }
    const end = entryExtentEnd(lines, i);
    if (!dropKeys.has(key)) {
      for (let j = i; j <= end; j += 1) out.push(lines[j] ?? "");
    }
    i = end + 1;
  }
  return out.join("\n");
}

/** The key a line assigns (`KEY=` / `export KEY=` / `KEY: `), or undefined. */
function matchAssignmentKey(line: string): string | undefined {
  const m = /^\s*(?:export\s+)?([\w.-]+)\s*(?:=|:[ \t])/.exec(line);
  return m?.[1];
}

/**
 * Index of the last physical line belonging to the entry starting at `start`.
 * An unquoted value is a single line. A value opening with `"`/`'`/`` ` `` runs
 * until the matching unescaped closing quote (dotenv allows newlines inside
 * quotes); an unterminated quote consumes to EOF (fail-safe — never leave a
 * dropped value's tail behind).
 */
function entryExtentEnd(lines: string[], start: number): number {
  const m = /^\s*(?:export\s+)?[\w.-]+\s*(?:=|:[ \t])(.*)$/.exec(lines[start] ?? "");
  if (!m) return start;
  const rhs = (m[1] ?? "").replace(/^[ \t]+/, "");
  const quote = rhs[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return start;
  let content = rhs.slice(1);
  for (let idx = start; idx < lines.length; idx += 1) {
    if (hasClosingQuote(content, quote)) return idx;
    content = lines[idx + 1] ?? "";
  }
  return lines.length - 1;
}

/** Whether `s` contains `quote` not immediately preceded by a single backslash. */
function hasClosingQuote(s: string, quote: string): boolean {
  for (let k = 0; k < s.length; k += 1) {
    if (s[k] === "\\" && s[k + 1] === quote) {
      k += 1; // escaped quote — skip both chars
      continue;
    }
    if (s[k] === quote) return true;
  }
  return false;
}

/** Surviving dropped names + value fragments after a `.env` rewrite (§B.4 3.d). */
export function verifyDotenvRedaction(
  rewritten: string,
  dropped: ReadonlyMap<string, string>,
): RedactionLeak[] {
  const parsed = parseDotenv(rewritten);
  const leaks: RedactionLeak[] = [];
  for (const name of dropped.keys()) {
    if (Object.prototype.hasOwnProperty.call(parsed, name)) {
      leaks.push({ kind: "name", name });
    }
  }
  leaks.push(...fragmentLeaks(rewritten, dropped));
  return leaks;
}

/**
 * Kept `.env` keys that did NOT survive redaction (gone, or value changed).
 *
 * The dropped-name/fragment verify only proves the removed credentials are gone;
 * it can't catch the inverse failure where a quote-extent miscalculation
 * over-consumes and silently swallows an ADJACENT kept entry. Run this on the
 * in-memory rewrite BEFORE writing, so a buggy redaction aborts without
 * clobbering the user's non-credential config.
 */
export function keptDotenvKeysLost(
  original: string,
  rewritten: string,
  dropKeys: ReadonlySet<string>,
): string[] {
  const before = parseDotenv(original);
  const after = parseDotenv(rewritten);
  const lost: string[] = [];
  for (const [name, value] of Object.entries(before)) {
    if (dropKeys.has(name)) continue;
    if (after[name] !== value) lost.push(name);
  }
  return lost;
}

// ─── settings.json ───────────────────────────────────────────────────────────

/** Rewrite settings.json with `dropKeys` removed from every kuzo entry's env. */
export function redactSettingsJson(raw: string, dropKeys: ReadonlySet<string>): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const servers = parsed.mcpServers;
  if (servers !== null && typeof servers === "object") {
    for (const entry of Object.values(servers as Record<string, unknown>)) {
      if (!isKuzoMcpEntry(entry)) continue;
      const env = entry.env;
      if (env === undefined || env === null || typeof env !== "object") continue;
      for (const key of dropKeys) {
        delete (env as Record<string, unknown>)[key];
      }
    }
  }
  const serialized = JSON.stringify(parsed, null, detectJsonIndent(raw));
  return raw.endsWith("\n") ? `${serialized}\n` : serialized;
}

/** Indent of the source's first indented line: a space count, a tab, or 2. */
function detectJsonIndent(raw: string): number | string {
  const m = /\n([ \t]+)\S/.exec(raw);
  const indent = m?.[1];
  if (indent === undefined) return 2;
  return indent.includes("\t") ? "\t" : indent.length;
}

/** Surviving dropped names + value fragments after a settings.json rewrite. */
export function verifySettingsRedaction(
  rewritten: string,
  dropped: ReadonlyMap<string, string>,
): RedactionLeak[] {
  const leaks: RedactionLeak[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rewritten);
  } catch {
    // A rewrite that no longer parses is itself a corruption — surface every
    // dropped name as a leak so the caller aborts loudly rather than trusting it.
    return [...dropped.keys()].map((name) => ({ kind: "name" as const, name }));
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (servers !== null && servers !== undefined && typeof servers === "object") {
    for (const entry of Object.values(servers as Record<string, unknown>)) {
      if (!isKuzoMcpEntry(entry)) continue;
      const env = entry.env;
      if (env === undefined || env === null || typeof env !== "object") continue;
      for (const name of dropped.keys()) {
        if (Object.prototype.hasOwnProperty.call(env, name)) {
          leaks.push({ kind: "name", name });
        }
      }
    }
  }
  // No value-fragment scan for settings.json: a credential value legitimately
  // shared with a NON-kuzo MCP server is that server's config, not a kuzo leak,
  // and JSON.stringify can't emit the orphaned multi-line fragments the .env
  // path guards against. Scoped name-presence in kuzo entries is the contract.
  return leaks;
}

// ─── shared ───────────────────────────────────────────────────────────────

/** Any non-trivial line of a dropped value that still appears in `rewritten`. */
function fragmentLeaks(
  rewritten: string,
  dropped: ReadonlyMap<string, string>,
): RedactionLeak[] {
  const leaks: RedactionLeak[] = [];
  for (const [name, value] of dropped) {
    for (const fragment of value.split(/\r?\n/)) {
      const trimmed = fragment.trim();
      if (trimmed.length >= FRAGMENT_MIN_LEN && rewritten.includes(trimmed)) {
        leaks.push({ kind: "fragment", name });
        break;
      }
    }
  }
  return leaks;
}
