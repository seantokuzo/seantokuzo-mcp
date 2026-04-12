/**
 * get_git_context tool — returns the current git repo/branch/status.
 */

import { z } from "zod";
import { defineTool } from "../../types.js";
import { getGitContext, getGitContextSummary } from "../git.js";

export const getGitContextTool = defineTool({
  name: "get_git_context",
  description: `Get the current git context including repository, branch, and status.

ALWAYS call this first when the user asks about PRs without specifying a repo/branch.
This tool reads live git state on every invocation — no caching, no stale reads.

Returns:
- What repository they're in (owner/repo)
- What branch they're on
- What the default branch is (for PR targets)
- Whether they have uncommitted or unpushed changes
- Recent commits on their branch`,
  inputSchema: z.object({}),
  handler: async (_args, _context) => {
    const ctx = getGitContext();

    if (!ctx.isGitRepo) {
      return {
        success: true,
        message: "Not currently in a git repository",
        data: { isGitRepo: false },
      };
    }

    return {
      success: true,
      message: getGitContextSummary(ctx),
      data: {
        isGitRepo: true,
        repository: ctx.fullRepo ?? null,
        owner: ctx.owner ?? null,
        repo: ctx.repo ?? null,
        currentBranch: ctx.currentBranch ?? null,
        defaultBranch: ctx.defaultBranch ?? null,
        hasUncommittedChanges: ctx.hasUncommittedChanges ?? false,
        hasUnpushedCommits: ctx.hasUnpushedCommits ?? false,
        changedFiles: ctx.changedFiles ?? [],
        recentCommits: ctx.recentCommits ?? [],
      },
    };
  },
});
