/**
 * Repository management tools for the github plugin.
 *
 * Seven tools: create/get/update/list repos, plus README read/write and
 * issue tracking status.
 */

import { z } from "zod";
import type { ToolDefinition } from "../../types.js";
import { getClient } from "../state.js";
import { resolveRepository } from "../shared.js";

// ============================================================================
// Shared schema fragments
// ============================================================================

const repositoryField = z
  .string()
  .optional()
  .describe(
    "Repository as owner/repo, full GitHub URL, or just the repo name if GITHUB_USERNAME is set. Auto-detected from the current git repo if omitted.",
  );

// ============================================================================
// create_repository
// ============================================================================

const createRepoSchema = z.object({
  name: z.string().describe("Repository name (owner is the authenticated user)"),
  description: z.string().optional().describe("Repository description"),
  private: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether to create a private repository"),
  auto_init: z
    .boolean()
    .optional()
    .default(false)
    .describe("Initialize with an empty README commit"),
  gitignore_template: z
    .string()
    .optional()
    .describe("A .gitignore template name (e.g. 'Node', 'Python')"),
  license_template: z
    .string()
    .optional()
    .describe("A license template keyword (e.g. 'mit', 'apache-2.0')"),
});

const createRepositoryTool: ToolDefinition = {
  name: "create_repository",
  description:
    "Create a new repository on GitHub under the authenticated user's account.",
  inputSchema: createRepoSchema,
  handler: async (args) => {
    const input = createRepoSchema.parse(args);
    const client = getClient();

    const repo = await client.createRepository(input);

    return {
      success: true,
      message: `Created repository ${repo.full_name}`,
      data: {
        name: repo.name,
        full_name: repo.full_name,
        url: repo.html_url,
        clone_url: repo.clone_url,
        ssh_url: repo.ssh_url,
        private: repo.private,
        default_branch: repo.default_branch,
      },
    };
  },
};

// ============================================================================
// get_repo_info
// ============================================================================

const getRepoInfoSchema = z.object({
  repository: repositoryField,
});

const getRepoInfoTool: ToolDefinition = {
  name: "get_repo_info",
  description:
    "Get detailed metadata about a repository (description, visibility, stars, default branch, etc.).",
  inputSchema: getRepoInfoSchema,
  handler: async (args, context) => {
    const input = getRepoInfoSchema.parse(args);
    const client = getClient();

    const { repo, source: repoSource } = await resolveRepository(
      context,
      input.repository,
      client.defaultOwner,
    );

    const info = await client.getRepoInfo(repo);

    return {
      success: true,
      resolved: {
        repository: {
          value: `${repo.owner}/${repo.repo}`,
          source: repoSource,
        },
      },
      data: info,
    };
  },
};

// ============================================================================
// update_repository
// ============================================================================

const updateRepoSchema = z.object({
  repository: repositoryField,
  name: z.string().optional().describe("New name for the repo"),
  description: z.string().optional().describe("New description"),
  private: z.boolean().optional().describe("Change visibility"),
  has_issues: z.boolean().optional().describe("Enable/disable issues"),
  has_wiki: z.boolean().optional().describe("Enable/disable wiki"),
  has_projects: z.boolean().optional().describe("Enable/disable projects"),
});

const updateRepositoryTool: ToolDefinition = {
  name: "update_repository",
  description:
    "Update repository settings — name, description, visibility, and feature toggles (issues/wiki/projects).",
  inputSchema: updateRepoSchema,
  handler: async (args, context) => {
    const input = updateRepoSchema.parse(args);
    const client = getClient();

    const { repo, source: repoSource } = await resolveRepository(
      context,
      input.repository,
      client.defaultOwner,
    );

    const updated = await client.updateRepository({
      repo,
      name: input.name,
      description: input.description,
      private: input.private,
      has_issues: input.has_issues,
      has_wiki: input.has_wiki,
      has_projects: input.has_projects,
    });

    return {
      success: true,
      message: `Updated repository ${updated.full_name}`,
      resolved: {
        repository: {
          value: `${repo.owner}/${repo.repo}`,
          source: repoSource,
        },
      },
      data: updated,
    };
  },
};

// ============================================================================
// list_my_repos
// ============================================================================

const listMyReposSchema = z.object({
  sort: z
    .enum(["created", "updated", "pushed", "full_name"])
    .optional()
    .default("updated")
    .describe("Sort order for the results"),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(30)
    .describe("Max repos to return (1-100)"),
});

const listMyReposTool: ToolDefinition = {
  name: "list_my_repos",
  description:
    "List repositories for the authenticated user, sorted by recent activity by default.",
  inputSchema: listMyReposSchema,
  handler: async (args) => {
    const input = listMyReposSchema.parse(args);
    const client = getClient();

    const repos = await client.listMyRepos({
      sort: input.sort,
      per_page: input.per_page,
    });

    return {
      success: true,
      message: `Found ${repos.length} repository(ies)`,
      data: repos.map((r) => ({
        name: r.name,
        full_name: r.full_name,
        description: r.description,
        private: r.private,
        url: r.html_url,
        default_branch: r.default_branch,
        stars: r.stargazers_count,
        forks: r.forks_count,
        open_issues: r.open_issues_count,
        updated_at: r.updated_at,
      })),
    };
  },
};

// ============================================================================
// get_readme
// ============================================================================

const getReadmeSchema = z.object({
  repository: repositoryField,
});

const getReadmeTool: ToolDefinition = {
  name: "get_readme",
  description:
    "Get the README.md content for a repository. Returns null if no README exists.",
  inputSchema: getReadmeSchema,
  handler: async (args, context) => {
    const input = getReadmeSchema.parse(args);
    const client = getClient();

    const { repo, source: repoSource } = await resolveRepository(
      context,
      input.repository,
      client.defaultOwner,
    );

    const readme = await client.getReadme(repo);

    if (!readme) {
      return {
        success: true,
        message: `No README found in ${repo.owner}/${repo.repo}`,
        resolved: {
          repository: {
            value: `${repo.owner}/${repo.repo}`,
            source: repoSource,
          },
        },
        data: null,
      };
    }

    return {
      success: true,
      resolved: {
        repository: {
          value: `${repo.owner}/${repo.repo}`,
          source: repoSource,
        },
      },
      data: {
        content: readme.content,
        sha: readme.sha,
        length: readme.content.length,
      },
    };
  },
};

// ============================================================================
// update_readme
// ============================================================================

const updateReadmeSchema = z.object({
  repository: repositoryField,
  content: z.string().describe("New README.md content (plain markdown, not base64)"),
  message: z
    .string()
    .optional()
    .describe(
      "Commit message. Defaults to 'Update README.md' or 'Create README.md'.",
    ),
});

const updateReadmeTool: ToolDefinition = {
  name: "update_readme",
  description:
    "Create or update the README.md for a repository. Pass raw markdown content — base64 encoding is handled internally.",
  inputSchema: updateReadmeSchema,
  handler: async (args, context) => {
    const input = updateReadmeSchema.parse(args);
    const client = getClient();

    const { repo } = await resolveRepository(
      context,
      input.repository,
      client.defaultOwner,
    );

    const result = await client.updateReadme(repo, input.content, input.message);

    return {
      success: true,
      message: `Updated README.md for ${repo.owner}/${repo.repo}`,
      data: result,
    };
  },
};

// ============================================================================
// check_issues
// ============================================================================

const checkIssuesSchema = z.object({
  repository: repositoryField,
});

const checkIssuesTool: ToolDefinition = {
  name: "check_issues",
  description:
    "Check whether issues are enabled on a repository and get basic open/closed counts.",
  inputSchema: checkIssuesSchema,
  handler: async (args, context) => {
    const input = checkIssuesSchema.parse(args);
    const client = getClient();

    const { repo, source: repoSource } = await resolveRepository(
      context,
      input.repository,
      client.defaultOwner,
    );

    const status = await client.checkIssues(repo);

    return {
      success: true,
      resolved: {
        repository: {
          value: `${repo.owner}/${repo.repo}`,
          source: repoSource,
        },
      },
      data: status,
    };
  },
};

// ============================================================================
// Export
// ============================================================================

export const repoTools: ToolDefinition[] = [
  createRepositoryTool,
  getRepoInfoTool,
  updateRepositoryTool,
  listMyReposTool,
  getReadmeTool,
  updateReadmeTool,
  checkIssuesTool,
];
