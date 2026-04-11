/**
 * git://context resource — JSON snapshot of the current git state.
 */

import type { ResourceDefinition } from "../../types.js";
import { getGitContext } from "../git.js";

export const gitContextResource: ResourceDefinition = {
  uri: "git://context",
  name: "Current Git Context",
  description:
    "Information about the current git repository, branch, and status",
  mimeType: "application/json",
  handler: async (_context) => {
    const ctx = getGitContext();
    return JSON.stringify(
      {
        isGitRepo: ctx.isGitRepo,
        repository: ctx.fullRepo ?? null,
        currentBranch: ctx.currentBranch ?? null,
        defaultBranch: ctx.defaultBranch ?? null,
        hasUncommittedChanges: ctx.hasUncommittedChanges ?? false,
        hasUnpushedCommits: ctx.hasUnpushedCommits ?? false,
        recentCommits: ctx.recentCommits ?? [],
      },
      null,
      2,
    );
  },
};
