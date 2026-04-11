/**
 * Branch and file-content tools for the github plugin.
 *
 * Two tools: listing branches and reading file contents at a specific ref.
 */

import { z } from "zod";
import type { ToolDefinition } from "../../types.js";
import { getClient } from "../state.js";
import { resolveRepository } from "../shared.js";

const repositoryField = z
  .string()
  .optional()
  .describe(
    "Repository as owner/repo, full GitHub URL, or just the repo name if GITHUB_USERNAME is set. Auto-detected from the current git repo if omitted.",
  );

// ============================================================================
// list_branches
// ============================================================================

const listBranchesSchema = z.object({
  repository: repositoryField,
});

const listBranchesTool: ToolDefinition = {
  name: "list_branches",
  description:
    "List all branches in a repository, including their protection status and the SHA of the latest commit on each.",
  inputSchema: listBranchesSchema,
  handler: async (args, context) => {
    const input = listBranchesSchema.parse(args);
    const client = getClient();

    const { repo, source: repoSource } = await resolveRepository(
      context,
      input.repository,
      client.defaultOwner,
    );

    const branches = await client.listBranches(repo);

    return {
      success: true,
      message: `Found ${branches.length} branch(es) in ${repo.owner}/${repo.repo}`,
      resolved: {
        repository: {
          value: `${repo.owner}/${repo.repo}`,
          source: repoSource,
        },
      },
      data: branches,
    };
  },
};

// ============================================================================
// get_file_content
// ============================================================================

const getFileContentSchema = z.object({
  repository: repositoryField,
  path: z
    .string()
    .describe("File path within the repository (e.g. 'src/index.ts')"),
  ref: z
    .string()
    .describe(
      "Git ref — branch name, tag, or commit SHA. Defaults to the repo's default branch if you just want the latest main.",
    ),
});

const getFileContentTool: ToolDefinition = {
  name: "get_file_content",
  description:
    "Read the contents of a single file from a GitHub repository at a specific ref. Returns null if the file doesn't exist.",
  inputSchema: getFileContentSchema,
  handler: async (args, context) => {
    const input = getFileContentSchema.parse(args);
    const client = getClient();

    const { repo } = await resolveRepository(
      context,
      input.repository,
      client.defaultOwner,
    );

    const content = await client.getFileContent(repo, input.path, input.ref);

    if (content === null) {
      return {
        success: true,
        message: `File not found: ${input.path} @ ${input.ref}`,
        data: null,
      };
    }

    return {
      success: true,
      data: {
        path: input.path,
        ref: input.ref,
        content,
        length: content.length,
      },
    };
  },
};

// ============================================================================
// Export
// ============================================================================

export const branchTools: ToolDefinition[] = [
  listBranchesTool,
  getFileContentTool,
];
