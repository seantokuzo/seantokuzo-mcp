/**
 * Installed-plugins registry (`~/.kuzo/plugins/index.json`) — schema v1.
 *
 * Single source of truth for "what's installed" (spec §D.7). Retention policy
 * is hardcoded at last 3 versions per plugin (locked-decision #7).
 *
 * Also owns `ensurePluginsRoot()` — first-run bootstrap of the plugins dir.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

import { indexJsonPath, pluginsRoot } from "./paths.js";

export const PLUGINS_INDEX_SCHEMA_VERSION = 1;
export const MAX_RETAINED_VERSIONS = 3;

export type PluginSource = "first-party" | "third-party";

export interface PluginIndexEntry {
  currentVersion: string;
  packageName: string;
  installedAt: string;
  lastUpdatedAt: string;
  source: PluginSource;
  retainedVersions: string[];
  integrity: string;
}

export interface PluginsIndex {
  schemaVersion: typeof PLUGINS_INDEX_SCHEMA_VERSION;
  plugins: Record<string, PluginIndexEntry>;
}

/** Create `~/.kuzo/plugins/` if it doesn't exist. Idempotent. */
export function ensurePluginsRoot(): void {
  mkdirSync(pluginsRoot(), { recursive: true });
}

/** Read index.json, returning an empty index if the file is missing. */
export function readIndex(): PluginsIndex {
  const path = indexJsonPath();
  if (!existsSync(path)) {
    return { schemaVersion: PLUGINS_INDEX_SCHEMA_VERSION, plugins: {} };
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as PluginsIndex;

  if (parsed.schemaVersion !== PLUGINS_INDEX_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported plugins index schema version: ${String(parsed.schemaVersion)}. ` +
        `Expected ${PLUGINS_INDEX_SCHEMA_VERSION}.`,
    );
  }
  if (!parsed.plugins || typeof parsed.plugins !== "object" || Array.isArray(parsed.plugins)) {
    throw new Error("Invalid plugins index: `plugins` must be an object.");
  }

  return parsed;
}

/** Write index.json atomically (tmp file + rename). */
export function writeIndex(index: PluginsIndex): void {
  ensurePluginsRoot();
  const path = indexJsonPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 2) + "\n", "utf-8");
  // fs.renameSync is atomic on the same filesystem (POSIX + NTFS).
  renameSync(tmp, path);
}

/**
 * Upsert a plugin entry and enforce MAX_RETAINED_VERSIONS. Returns the list of
 * version directories the caller should `rm -rf` to honor retention.
 */
export function upsertEntry(
  index: PluginsIndex,
  name: string,
  entry: Omit<PluginIndexEntry, "retainedVersions"> & {
    retainedVersions?: string[];
  },
): { index: PluginsIndex; prunedVersions: string[] } {
  const existing = index.plugins[name];
  const retainedIncoming = entry.retainedVersions ?? [
    entry.currentVersion,
    ...(existing?.retainedVersions ?? []).filter(
      (v) => v !== entry.currentVersion,
    ),
  ];

  const retained = retainedIncoming.slice(0, MAX_RETAINED_VERSIONS);
  const prunedVersions = retainedIncoming.slice(MAX_RETAINED_VERSIONS);

  index.plugins[name] = {
    currentVersion: entry.currentVersion,
    packageName: entry.packageName,
    installedAt: existing?.installedAt ?? entry.installedAt,
    lastUpdatedAt: entry.lastUpdatedAt,
    source: entry.source,
    retainedVersions: retained,
    integrity: entry.integrity,
  };

  return { index, prunedVersions };
}
