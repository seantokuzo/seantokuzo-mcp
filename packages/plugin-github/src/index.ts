/**
 * github plugin — GitHub integration for Kuzo MCP.
 *
 * Exposes ~23 tools spanning pull requests, reviews, repositories, branches,
 * and file content. Cross-plugin: calls `get_git_context` from the git-context
 * plugin to auto-detect repo and branch on PR operations.
 *
 * Credentials: GITHUB_TOKEN via credential broker (access: "client")
 * Optional: GITHUB_USERNAME via credential broker (access: "raw")
 */

import type { KuzoPluginV2 } from "@kuzo-mcp/types";
import type { GitHubClient } from "./client.js";
import { setClient, resetClient } from "./state.js";
import { pullRequestTools } from "./tools/pulls.js";
import { reviewTools } from "./tools/reviews.js";
import { repoTools } from "./tools/repos.js";
import { branchTools } from "./tools/branches.js";
import pkgJson from "../package.json" with { type: "json" };

const plugin: KuzoPluginV2 = {
  name: "github",
  description:
    "GitHub integration — pull requests, reviews, repository management, branches, and file content. Auto-detects repo and branch via the git-context plugin.",
  version: pkgJson.version,
  permissionModel: 1,
  capabilities: [
    {
      kind: "credentials",
      env: "GITHUB_TOKEN",
      access: "client",
      reason: "Authenticates with the GitHub API for all operations",
    },
    {
      kind: "network",
      domain: "api.github.com",
      reason: "All GitHub API calls",
    },
    {
      kind: "cross-plugin",
      target: "git-context",
      reason: "Auto-detect repository and branch from local git",
    },
  ],
  optionalCapabilities: [
    {
      kind: "credentials",
      env: "GITHUB_USERNAME",
      access: "raw",
      reason: "Default owner for short repo names (e.g., 'myrepo' → 'owner/myrepo')",
    },
  ],
  tools: [
    ...pullRequestTools,
    ...reviewTools,
    ...repoTools,
    ...branchTools,
  ],
  async initialize(context) {
    // Get pre-authenticated client from the credential broker.
    // The factory reads GITHUB_TOKEN + GITHUB_USERNAME and constructs GitHubClient.
    const client = context.credentials.getClient<GitHubClient>("github");
    if (!client) {
      throw new Error(
        "Failed to create GitHub client — GITHUB_TOKEN may be missing. Set it in your .env file or environment.",
      );
    }

    const { valid, username: authedUser, error } = await client.verifyConnection();
    if (!valid) {
      throw new Error(
        `GitHub authentication failed: ${error ?? "unknown error"}`,
      );
    }

    setClient(client);
    context.logger.info(
      `github plugin initialized (authenticated as ${authedUser})`,
    );
  },
  async shutdown() {
    resetClient();
  },
};

export default plugin;
