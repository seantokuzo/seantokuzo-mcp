/**
 * 🧠 MCP Server
 * The Model Context Protocol server that Claude talks to
 *
 * MCP allows Claude to call your custom tools. This server exposes
 * PR management tools that Claude can use when you ask it to create
 * or update pull requests.
 *
 * ✨ NEW: Automatically detects git context so Claude knows your repo/branch!
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
  type Resource,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getGitHubService } from "../services/github.js";
import {
  getGitContext,
  getGitContextSummary,
  type GitContext,
} from "../services/git.js";
import logger from "../utils/logger.js";

// ============================================
// Git Context (cached, refreshed on each tool call)
// ============================================

let cachedGitContext: GitContext | null = null;

function refreshGitContext(): GitContext {
  cachedGitContext = getGitContext();
  return cachedGitContext;
}

function getCurrentContext(): GitContext {
  if (!cachedGitContext) {
    return refreshGitContext();
  }
  return cachedGitContext;
}

// ============================================
// Tool Definitions
// ============================================

const tools: Tool[] = [
  {
    name: "get_git_context",
    description: `Get the current git context including repository, branch, and status.
    
ALWAYS call this first when the user asks about PRs without specifying a repo/branch.
This tells you:
- What repository they're in (owner/repo)
- What branch they're on
- What the default branch is (for PR targets)
- Whether they have uncommitted or unpushed changes
- Recent commits on their branch`,
    inputSchema: {
      type: "object",
      properties: {
        refresh: {
          type: "boolean",
          description: "Force refresh the git context",
          default: true,
        },
      },
      required: [],
    },
  },
  {
    name: "create_pull_request",
    description: `Create a new GitHub pull request. Use this when the user wants to open a PR.
    
💡 TIP: Call get_git_context first to auto-detect repo and branch if user didn't specify.
    
You can provide context about the changes to generate a better description.
The tool will analyze commits and file changes automatically.`,
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          description:
            "Repository in format owner/repo. If not provided, uses current git context.",
        },
        source_branch: {
          type: "string",
          description:
            "The branch with the changes. If not provided, uses current branch.",
        },
        target_branch: {
          type: "string",
          description:
            "The branch to merge into. If not provided, uses default branch (main/master).",
        },
        title: {
          type: "string",
          description:
            "PR title. If not provided, will be generated from commits.",
        },
        description: {
          type: "string",
          description:
            "Additional context about the changes to include in the PR description. Ask the user for this!",
        },
        draft: {
          type: "boolean",
          description: "Whether to create as a draft PR",
          default: false,
        },
      },
      required: [], // None required anymore - we can auto-detect!
    },
  },
  {
    name: "update_pull_request",
    description: `Update an existing GitHub pull request's title and/or description.
    
💡 TIP: If user doesn't specify PR number, use find_pr_for_branch with their current branch.
    
Use this when the user wants to improve a PR description or update it after pushing new changes.`,
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          description:
            "Repository in format owner/repo. If not provided, uses current git context.",
        },
        pull_number: {
          type: "number",
          description:
            "The PR number to update. If not provided, finds PR for current branch.",
        },
        title: {
          type: "string",
          description: "New title for the PR (optional)",
        },
        description: {
          type: "string",
          description: "Additional context to regenerate the PR description",
        },
        append_to_existing: {
          type: "boolean",
          description:
            "If true, append new context to existing description instead of replacing",
          default: false,
        },
      },
      required: [], // None required - we can auto-detect!
    },
  },
  {
    name: "get_pull_request",
    description: "Get details about a specific pull request",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          description:
            "Repository in format owner/repo. If not provided, uses current git context.",
        },
        pull_number: {
          type: "number",
          description: "The PR number",
        },
      },
      required: ["pull_number"],
    },
  },
  {
    name: "list_pull_requests",
    description: "List pull requests for a repository",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          description:
            "Repository in format owner/repo. If not provided, uses current git context.",
        },
        state: {
          type: "string",
          enum: ["open", "closed", "all"],
          description: "Filter by PR state",
          default: "open",
        },
      },
      required: [], // Can auto-detect repo
    },
  },
  {
    name: "find_pr_for_branch",
    description:
      "Find the pull request associated with a specific branch. Useful to check if a PR already exists.",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          description:
            "Repository in format owner/repo. If not provided, uses current git context.",
        },
        branch: {
          type: "string",
          description:
            "The branch name to find a PR for. If not provided, uses current branch.",
        },
      },
      required: [], // Can auto-detect both!
    },
  },
];

// ============================================
// Resource Definitions (for context Claude can read)
// ============================================

const resources: Resource[] = [
  {
    uri: "git://context",
    name: "Current Git Context",
    description:
      "Information about the current git repository, branch, and status",
    mimeType: "application/json",
  },
];

// ============================================
// Tool Handlers
// ============================================

// Zod schemas for validation
const GetGitContextSchema = z.object({
  refresh: z.boolean().optional().default(true),
});

const CreatePRSchema = z.object({
  repository: z.string().optional(),
  source_branch: z.string().optional(),
  target_branch: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  draft: z.boolean().optional().default(false),
});

const UpdatePRSchema = z.object({
  repository: z.string().optional(),
  pull_number: z.number().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  append_to_existing: z.boolean().optional().default(false),
});

const GetPRSchema = z.object({
  repository: z.string().optional(),
  pull_number: z.number(),
});

const ListPRsSchema = z.object({
  repository: z.string().optional(),
  state: z.enum(["open", "closed", "all"]).optional().default("open"),
});

const FindPRSchema = z.object({
  repository: z.string().optional(),
  branch: z.string().optional(),
});

/**
 * Handle get_git_context - returns current git state
 */
async function handleGetGitContext(args: unknown) {
  const input = GetGitContextSchema.parse(args);

  if (input.refresh) {
    refreshGitContext();
  }

  const context = getCurrentContext();

  if (!context.isGitRepo) {
    return {
      success: true,
      message: "Not currently in a git repository",
      data: { isGitRepo: false },
    };
  }

  return {
    success: true,
    message: getGitContextSummary(context),
    data: {
      isGitRepo: true,
      repository: context.fullRepo || null,
      owner: context.owner || null,
      repo: context.repo || null,
      currentBranch: context.currentBranch || null,
      defaultBranch: context.defaultBranch || null,
      hasUncommittedChanges: context.hasUncommittedChanges || false,
      hasUnpushedCommits: context.hasUnpushedCommits || false,
      changedFiles: context.changedFiles || [],
      recentCommits: context.recentCommits || [],
    },
  };
}

/**
 * Resolve repository from input or context
 */
function resolveRepository(inputRepo?: string): {
  owner: string;
  repo: string;
} {
  if (inputRepo) {
    const github = getGitHubService();
    return github.parseRepoIdentifier(inputRepo);
  }

  const context = getCurrentContext();
  if (!context.isGitRepo || !context.owner || !context.repo) {
    throw new Error(
      "No repository specified and not in a git repository. Please provide a repository.",
    );
  }

  return { owner: context.owner, repo: context.repo };
}

/**
 * Handle create_pull_request
 */
async function handleCreatePR(args: unknown) {
  const input = CreatePRSchema.parse(args);
  const github = getGitHubService();

  // Refresh context for latest branch info
  refreshGitContext();
  const context = getCurrentContext();

  // Resolve repo
  const repo = resolveRepository(input.repository);
  const fullRepo = `${repo.owner}/${repo.repo}`;

  // Resolve branches
  const sourceBranch = input.source_branch || context.currentBranch;
  const targetBranch = input.target_branch || context.defaultBranch || "main";

  // Track what was auto-detected vs explicitly provided
  const resolved = {
    repository: {
      value: fullRepo,
      source: input.repository ? "provided" : "auto-detected from git",
    },
    sourceBranch: {
      value: sourceBranch,
      source: input.source_branch
        ? "provided"
        : "auto-detected (current branch)",
    },
    targetBranch: {
      value: targetBranch,
      source: input.target_branch
        ? "provided"
        : "auto-detected (default branch)",
    },
  };

  if (!sourceBranch) {
    throw new Error(
      "Could not determine source branch. Please specify source_branch.",
    );
  }

  if (sourceBranch === targetBranch) {
    throw new Error(
      `Source branch (${sourceBranch}) and target branch (${targetBranch}) are the same. Cannot create PR.`,
    );
  }

  // Check if PR already exists
  const existingPR = await github.findPRForBranch(repo, sourceBranch);
  if (existingPR) {
    return {
      success: false,
      message: `A PR already exists for branch ${sourceBranch}`,
      resolved,
      data: {
        existingPR: {
          number: existingPR.number,
          title: existingPR.title,
          url: existingPR.html_url,
        },
      },
    };
  }

  // Get commits for context
  const commits = await github.getCommitsBetween(
    repo,
    targetBranch,
    sourceBranch,
  );
  const diffStats = await github.getDiffStats(repo, targetBranch, sourceBranch);

  // Generate title if not provided
  const title =
    input.title ||
    commits[0]?.message.split("\n")[0] ||
    `Merge ${sourceBranch} into ${targetBranch}`;

  // Generate description
  const body = generatePRDescription({
    commits,
    diffStats,
    userContext: input.description,
    sourceBranch,
    targetBranch,
  });

  const pr = await github.createPullRequest({
    repo,
    title,
    body,
    head: sourceBranch,
    base: targetBranch,
    draft: input.draft,
  });

  return {
    success: true,
    message: `🚀 Created PR #${pr.number}: ${pr.title}`,
    resolved,
    data: {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      state: pr.state,
      draft: pr.draft,
      repository: fullRepo,
      sourceBranch,
      targetBranch,
      commits: commits.length,
      filesChanged: diffStats.changedFiles,
      additions: diffStats.additions,
      deletions: diffStats.deletions,
    },
  };
}

/**
 * Handle update_pull_request
 */
async function handleUpdatePR(args: unknown) {
  const input = UpdatePRSchema.parse(args);
  const github = getGitHubService();

  // Refresh context
  refreshGitContext();
  const context = getCurrentContext();

  // Resolve repo
  const repo = resolveRepository(input.repository);
  const fullRepo = `${repo.owner}/${repo.repo}`;

  // Resolve PR number
  let pullNumber = input.pull_number;
  let prSource = "provided";
  if (!pullNumber) {
    // Try to find PR for current branch
    const branch = context.currentBranch;
    if (!branch) {
      throw new Error(
        "No PR number specified and could not determine current branch.",
      );
    }

    const pr = await github.findPRForBranch(repo, branch);
    if (!pr) {
      throw new Error(
        `No open PR found for branch ${branch}. Please specify pull_number.`,
      );
    }
    pullNumber = pr.number;
    prSource = `auto-detected from branch ${branch}`;
  }

  // Track what was resolved
  const resolved = {
    repository: {
      value: fullRepo,
      source: input.repository ? "provided" : "auto-detected from git",
    },
    pullNumber: {
      value: pullNumber,
      source: prSource,
    },
  };

  // Get current PR
  const currentPR = await github.getPullRequest(repo, pullNumber);

  // Get commits for context
  const commits = await github.getPRCommits(repo, pullNumber);

  let newBody: string;
  if (input.append_to_existing && currentPR.body) {
    // Append new context to existing
    newBody =
      currentPR.body +
      "\n\n---\n\n## 📝 Update\n\n" +
      (input.description || "");
  } else {
    // Generate new description
    newBody = generatePRDescription({
      commits,
      diffStats: {
        additions: currentPR.additions,
        deletions: currentPR.deletions,
        changedFiles: currentPR.changed_files,
      },
      userContext: input.description,
      sourceBranch: currentPR.head.ref,
      targetBranch: currentPR.base.ref,
    });
  }

  const pr = await github.updatePullRequest({
    repo,
    pullNumber,
    title: input.title,
    body: newBody,
  });

  return {
    success: true,
    message: `✏️ Updated PR #${pr.number}`,
    resolved,
    data: {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      repository: fullRepo,
      sourceBranch: currentPR.head.ref,
      targetBranch: currentPR.base.ref,
    },
  };
}

/**
 * Handle get_pull_request
 */
async function handleGetPR(args: unknown) {
  const input = GetPRSchema.parse(args);
  const github = getGitHubService();

  const repo = resolveRepository(input.repository);
  const fullRepo = `${repo.owner}/${repo.repo}`;

  // Track what was resolved
  const resolved = {
    repository: {
      value: fullRepo,
      source: input.repository ? "provided" : "auto-detected from git",
    },
    pullNumber: {
      value: input.pull_number,
      source: "provided",
    },
  };

  const pr = await github.getPullRequest(repo, input.pull_number);

  return {
    success: true,
    resolved,
    data: {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      draft: pr.draft,
      url: pr.html_url,
      repository: fullRepo,
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      author: pr.user?.login,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
    },
  };
}

/**
 * Handle list_pull_requests
 */
async function handleListPRs(args: unknown) {
  const input = ListPRsSchema.parse(args);
  const github = getGitHubService();

  const repo = resolveRepository(input.repository);
  const fullRepo = `${repo.owner}/${repo.repo}`;

  // Track what was resolved
  const resolved = {
    repository: {
      value: fullRepo,
      source: input.repository ? "provided" : "auto-detected from git",
    },
    state: {
      value: input.state,
      source: "provided (default: open)",
    },
  };

  const prs = await github.listPullRequests(repo, input.state);

  return {
    success: true,
    message: `Found ${prs.length} ${input.state} PR(s)`,
    resolved,
    data: prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      draft: pr.draft,
      url: pr.html_url,
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      author: pr.user?.login,
    })),
  };
}

/**
 * Handle find_pr_for_branch
 */
async function handleFindPR(args: unknown) {
  const input = FindPRSchema.parse(args);
  const github = getGitHubService();

  // Refresh context
  refreshGitContext();
  const context = getCurrentContext();

  const repo = resolveRepository(input.repository);
  const fullRepo = `${repo.owner}/${repo.repo}`;
  const branch = input.branch || context.currentBranch;

  if (!branch) {
    throw new Error(
      "No branch specified and could not determine current branch.",
    );
  }

  // Track what was resolved
  const resolved = {
    repository: {
      value: fullRepo,
      source: input.repository ? "provided" : "auto-detected from git",
    },
    branch: {
      value: branch,
      source: input.branch ? "provided" : "auto-detected (current branch)",
    },
  };

  const pr = await github.findPRForBranch(repo, branch);

  if (!pr) {
    return {
      success: true,
      message: `No open PR found for branch ${branch}`,
      resolved,
      data: null,
    };
  }

  return {
    success: true,
    message: `Found PR #${pr.number} for branch ${branch}`,
    resolved,
    data: {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      state: pr.state,
      repository: fullRepo,
    },
  };
}

// ============================================
// Description Generator
// ============================================

function generatePRDescription(context: {
  commits: Array<{ message: string; sha: string; author: string }>;
  diffStats: { additions: number; deletions: number; changedFiles: number };
  userContext?: string;
  sourceBranch: string;
  targetBranch: string;
}): string {
  const { commits, diffStats, userContext, sourceBranch, targetBranch } =
    context;

  const sections: string[] = [];

  // Description section
  sections.push("## 📋 Description");
  if (userContext && userContext.trim()) {
    sections.push(userContext.trim());
  } else {
    sections.push(
      `This PR merges \`${sourceBranch}\` into \`${targetBranch}\`.`,
    );
  }

  // Changes summary
  sections.push("");
  sections.push("## 📊 Changes");
  sections.push(`- **Files changed:** ${diffStats.changedFiles}`);
  sections.push(`- **Additions:** +${diffStats.additions}`);
  sections.push(`- **Deletions:** -${diffStats.deletions}`);

  // Commits section
  if (commits.length > 0) {
    sections.push("");
    sections.push("## 📝 Commits");
    commits.slice(0, 10).forEach((commit) => {
      const message = commit.message.split("\n")[0] || "";
      sections.push(`- \`${commit.sha.slice(0, 7)}\` ${message}`);
    });
    if (commits.length > 10) {
      sections.push(`- ... and ${commits.length - 10} more commits`);
    }
  }

  // Checklist
  sections.push("");
  sections.push("## ✅ Checklist");
  sections.push("- [ ] Code has been tested");
  sections.push("- [ ] Documentation updated (if needed)");
  sections.push("- [ ] No breaking changes (or documented if any)");

  // Footer
  sections.push("");
  sections.push("---");
  sections.push(
    "*Generated by [Sean-MCP](https://github.com/seantokuzo/seantokuzo-mcp) 🚀*",
  );

  return sections.join("\n");
}

// ============================================
// Server Setup
// ============================================

async function main() {
  logger.info("Starting Sean-MCP Server...");

  // Initialize git context
  refreshGitContext();
  const context = getCurrentContext();
  if (context.isGitRepo) {
    logger.info(`📍 Detected repo: ${context.fullRepo || "unknown"}`);
    logger.info(`🌿 Current branch: ${context.currentBranch || "unknown"}`);
  }

  const server = new Server(
    {
      name: "sean-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  // List available resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources };
  });

  // Read resource
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === "git://context") {
      refreshGitContext();
      const context = getCurrentContext();

      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                isGitRepo: context.isGitRepo,
                repository: context.fullRepo || null,
                currentBranch: context.currentBranch || null,
                defaultBranch: context.defaultBranch || null,
                hasUncommittedChanges: context.hasUncommittedChanges || false,
                hasUnpushedCommits: context.hasUnpushedCommits || false,
                recentCommits: context.recentCommits || [],
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result;

      switch (name) {
        case "get_git_context":
          result = await handleGetGitContext(args);
          break;
        case "create_pull_request":
          result = await handleCreatePR(args);
          break;
        case "update_pull_request":
          result = await handleUpdatePR(args);
          break;
        case "get_pull_request":
          result = await handleGetPR(args);
          break;
        case "list_pull_requests":
          result = await handleListPRs(args);
          break;
        case "find_pr_for_branch":
          result = await handleFindPR(args);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Tool ${name} failed:`, error);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: false,
                error: errorMessage,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("Sean-MCP Server running on stdio");
}

main().catch((error) => {
  logger.error("Failed to start MCP server:", error);
  process.exit(1);
});
