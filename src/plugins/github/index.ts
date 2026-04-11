/**
 * github plugin — GitHub integration for Kuzo MCP.
 *
 * Exposes ~23 tools spanning pull requests, reviews, repositories, branches,
 * and file content. Cross-plugin: calls `get_git_context` from the git-context
 * plugin to auto-detect repo and branch on PR operations.
 *
 * Required config: GITHUB_TOKEN
 * Optional config: GITHUB_USERNAME (used as default owner for short repo names)
 */

import type { KuzoPlugin } from "../types.js";
import { GitHubClient } from "./client.js";
import { setClient, resetClient } from "./state.js";
import { pullRequestTools } from "./tools/pulls.js";
import { reviewTools } from "./tools/reviews.js";
import { repoTools } from "./tools/repos.js";
import { branchTools } from "./tools/branches.js";

const plugin: KuzoPlugin = {
  name: "github",
  description:
    "GitHub integration — pull requests, reviews, repository management, branches, and file content. Auto-detects repo and branch via the git-context plugin.",
  version: "1.0.0",
  requiredConfig: ["GITHUB_TOKEN"],
  optionalConfig: ["GITHUB_USERNAME", "GITHUB_ORG"],
  tools: [
    ...pullRequestTools,
    ...reviewTools,
    ...repoTools,
    ...branchTools,
  ],
  async initialize(context) {
    const token = context.config.get("GITHUB_TOKEN");
    if (!token) {
      throw new Error(
        "GITHUB_TOKEN is required. Set it in your .env file or environment.",
      );
    }

    const username = context.config.get("GITHUB_USERNAME");
    const client = new GitHubClient({
      token,
      username,
      logger: context.logger,
    });

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
