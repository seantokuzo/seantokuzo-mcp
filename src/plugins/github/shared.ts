/**
 * Shared helpers used across github plugin tools.
 *
 * Includes the cross-plugin bridge to git-context: `resolveRepository` falls
 * back to `callTool("get_git_context", {})` when the caller didn't provide a
 * repository. This is the first real use of the Phase 1 cross-plugin API.
 */

import type { PluginContext } from "../types.js";
import type { GitContextResult, GitHubRepo } from "./types.js";

/**
 * Parse a GitHub URL or `owner/repo` string into components.
 *
 * Accepts:
 *   - `https://github.com/owner/repo` / `...repo.git`
 *   - `git@github.com:owner/repo.git`
 *   - `owner/repo`
 *   - `repo` (only if `defaultOwner` is supplied, typically `GITHUB_USERNAME`)
 */
export function parseRepoIdentifier(
  input: string,
  defaultOwner?: string,
): GitHubRepo {
  const urlMatch = input.match(/github\.com[/:]([\w-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (urlMatch && urlMatch[1] && urlMatch[2]) {
    return { owner: urlMatch[1], repo: urlMatch[2] };
  }

  const parts = input.split("/");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { owner: parts[0], repo: parts[1] };
  }

  if (parts.length === 1 && parts[0] && defaultOwner) {
    return { owner: defaultOwner, repo: parts[0] };
  }

  throw new Error(
    `Invalid repository identifier: "${input}". Use owner/repo, a GitHub URL, or just the repo name if GITHUB_USERNAME is set.`,
  );
}

/**
 * Resolve the target repository for a tool call.
 *
 * Priority:
 *   1. Explicit `inputRepo` — parsed via `parseRepoIdentifier`
 *   2. Cross-plugin: `get_git_context` from the git-context plugin
 *
 * Throws if neither source yields an owner/repo.
 */
export async function resolveRepository(
  context: PluginContext,
  inputRepo: string | undefined,
  defaultOwner: string | undefined,
): Promise<{ repo: GitHubRepo; source: "provided" | "auto-detected from git" }> {
  if (inputRepo) {
    return {
      repo: parseRepoIdentifier(inputRepo, defaultOwner),
      source: "provided",
    };
  }

  const result = (await context.callTool(
    "get_git_context",
    {},
  )) as GitContextResult;

  const data = result?.data;
  if (!data?.isGitRepo || !data.owner || !data.repo) {
    throw new Error(
      "No repository specified and not in a git repository. Please provide a repository.",
    );
  }

  return {
    repo: { owner: data.owner, repo: data.repo },
    source: "auto-detected from git",
  };
}

/**
 * Fetch the current git context via cross-plugin callTool.
 * Returns null if not in a git repo or if git-context plugin is unavailable.
 */
export async function getGitContextSafe(
  context: PluginContext,
): Promise<GitContextResult["data"] | null> {
  try {
    const result = (await context.callTool(
      "get_git_context",
      {},
    )) as GitContextResult;
    if (!result?.data?.isGitRepo) return null;
    return result.data;
  } catch {
    return null;
  }
}
