/**
 * Source discovery for `kuzo credentials migrate` (spec §B.4 "Reads").
 *
 * Two source kinds:
 *   - claude    — `<home>/.claude/settings.json`; the env blocks of every MCP
 *                 server entry whose `command`/`args` look like kuzo.
 *   - env-file  — a BOUNDED ancestor walk (R22): cwd plus up to 5 parents, never
 *                 above `$HOME`, and only a directory whose sibling `package.json`
 *                 declares an `@kuzo-mcp/*` dependency. Plus an unconditional
 *                 `$HOME/.env`. NEVER `/.env`, `/etc/.env`, or anything outside
 *                 `$HOME`.
 *
 * Discovery is read-only enumeration: it follows symlinks (the symlink REFUSAL
 * is a write-path safety check in `migrate-fs.ts`, applied before any import).
 * `home`/`cwd` are injectable so the bounded-walk logic is testable against a
 * temp tree.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { parse as parseDotenv } from "dotenv";

export type MigrateSourceKind = "claude" | "env-file";

export interface MigrateSource {
  kind: MigrateSourceKind;
  /** Absolute path to the source file. */
  path: string;
  /** Known-credential entries found here (name → cleartext value). */
  entries: Map<string, string>;
}

/** A single `mcpServers` entry shape (only the fields migrate inspects). */
export interface McpServerEntry {
  command?: unknown;
  args?: unknown;
  env?: Record<string, unknown>;
}

export interface DiscoverOptions {
  /** Which source kinds to scan. */
  source: "claude" | "env-file" | "both";
  /** Union of `CredentialCapability.env` across installed plugins + legacy names. */
  knownEnvNames: ReadonlySet<string>;
  /** Home directory (default `os.homedir()`). */
  home?: string;
  /** Working directory the `.env` walk starts from (default `process.cwd()`). */
  cwd?: string;
}

/** How far up the `.env` ancestor walk may climb beyond cwd (R22). */
const ENV_WALK_MAX_ANCESTORS = 5;

/**
 * Does this `mcpServers` entry invoke kuzo? Matches `command` basename `kuzo`,
 * any `@kuzo-mcp/*` token in the command or args, or a `node`/`npx` invocation
 * referencing a kuzo package. Used by both discovery and redaction so the same
 * entries are read and rewritten.
 */
export function isKuzoMcpEntry(entry: unknown): entry is McpServerEntry {
  if (entry === null || typeof entry !== "object") return false;
  const e = entry as { command?: unknown; args?: unknown };
  const command = typeof e.command === "string" ? e.command : "";
  const args = Array.isArray(e.args)
    ? e.args.filter((a): a is string => typeof a === "string")
    : [];
  const base = command.split(/[\\/]/).pop() ?? "";
  if (base === "kuzo") return true;
  const haystack = [command, ...args].join(" ");
  if (haystack.includes("@kuzo-mcp/")) return true;
  if ((base === "node" || base === "npx") && args.some((a) => a.includes("kuzo-mcp"))) {
    return true;
  }
  return false;
}

/** Collect candidate sources per `--source`, filtered to `knownEnvNames`. */
export function discoverSources(opts: DiscoverOptions): MigrateSource[] {
  const home = resolve(opts.home ?? homedir());
  const cwd = resolve(opts.cwd ?? process.cwd());
  const sources: MigrateSource[] = [];

  if (opts.source === "claude" || opts.source === "both") {
    const claude = discoverClaudeSource(home, opts.knownEnvNames);
    if (claude) sources.push(claude);
  }

  if (opts.source === "env-file" || opts.source === "both") {
    for (const path of envFileCandidates(cwd, home)) {
      const source = discoverEnvFile(path, opts.knownEnvNames);
      if (source) sources.push(source);
    }
  }

  return sources;
}

// ─── claude settings.json ──────────────────────────────────────────────────

function discoverClaudeSource(
  home: string,
  known: ReadonlySet<string>,
): MigrateSource | undefined {
  const path = join(home, ".claude", "settings.json");
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // A settings.json we can't parse is one we can't safely redact either —
    // leave it out of the candidate set entirely.
    return undefined;
  }
  const entries = collectClaudeEntries(parsed, known);
  if (entries.size === 0) return undefined;
  return { kind: "claude", path, entries };
}

/** Union the known-cred env keys across every kuzo `mcpServers` entry. */
function collectClaudeEntries(
  parsed: unknown,
  known: ReadonlySet<string>,
): Map<string, string> {
  const entries = new Map<string, string>();
  if (parsed === null || typeof parsed !== "object") return entries;
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (servers === null || typeof servers !== "object") return entries;
  for (const entry of Object.values(servers as Record<string, unknown>)) {
    if (!isKuzoMcpEntry(entry)) continue;
    const env = entry.env;
    if (env === undefined || env === null || typeof env !== "object") continue;
    for (const [name, value] of Object.entries(env)) {
      if (!known.has(name) || typeof value !== "string" || value.length === 0) continue;
      if (!entries.has(name)) entries.set(name, value);
    }
  }
  return entries;
}

// ─── .env bounded walk ───────────────────────────────────────────────────────

function discoverEnvFile(
  path: string,
  known: ReadonlySet<string>,
): MigrateSource | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: Record<string, string>;
  try {
    parsed = parseDotenv(readFileSync(path));
  } catch {
    return undefined;
  }
  const entries = new Map<string, string>();
  for (const [name, value] of Object.entries(parsed)) {
    if (known.has(name) && value.length > 0) entries.set(name, value);
  }
  if (entries.size === 0) return undefined;
  return { kind: "env-file", path, entries };
}

/**
 * Absolute `.env` paths to consider: cwd + up to 5 ancestors that stay within
 * `$HOME` and declare an `@kuzo-mcp/*` dep, plus `$HOME/.env` unconditionally.
 * De-duplicated, order preserved (nearest-first, then `$HOME/.env`).
 */
function envFileCandidates(cwd: string, home: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (p: string): void => {
    if (!seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  };

  let dir = cwd;
  for (let level = 0; level <= ENV_WALK_MAX_ANCESTORS; level++) {
    if (!isWithinHome(dir, home)) break;
    if (dirDeclaresKuzoDep(dir)) add(join(dir, ".env"));
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  // $HOME/.env is always considered (no package.json gate).
  add(join(home, ".env"));
  return paths;
}

/** True when `dir` is `home` or a descendant of it. */
function isWithinHome(dir: string, home: string): boolean {
  return dir === home || dir.startsWith(home + sep);
}

/** True when `<dir>/package.json` declares an `@kuzo-mcp/*` (dev/peer)dependency. */
function dirDeclaresKuzoDep(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return false;
  }
  if (pkg === null || typeof pkg !== "object") return false;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const deps = (pkg as Record<string, unknown>)[field];
    if (deps === null || typeof deps !== "object") continue;
    for (const name of Object.keys(deps as Record<string, unknown>)) {
      if (name.startsWith("@kuzo-mcp/")) return true;
    }
  }
  return false;
}
