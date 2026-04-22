/**
 * git-context plugin — detects local git repo/branch/status.
 *
 * No external config required. Other plugins call `get_git_context` via
 * `context.callTool()` to resolve repo/branch automatically.
 */

import { createRequire } from "node:module";
import type { KuzoPluginV2 } from "@kuzo-mcp/types";
import { getGitContextTool } from "./tools/context.js";
import { gitContextResource } from "./resources/context.js";

const pkgJson = createRequire(import.meta.url)("../package.json") as { version: string };

const plugin: KuzoPluginV2 = {
  name: "git-context",
  description:
    "Detects the current git repository, branch, and working tree state from the local filesystem",
  version: pkgJson.version,
  permissionModel: 1,
  capabilities: [
    {
      kind: "filesystem",
      access: "read",
      path: "$CWD/.git/**",
      reason: "Read git metadata to detect repo, branch, and working tree state",
    },
    {
      kind: "system",
      operation: "exec",
      command: "git",
      reason: "Run git commands for branch, status, and remote detection",
    },
  ],
  tools: [getGitContextTool],
  resources: [gitContextResource],
  async initialize(context) {
    context.logger.info("git-context plugin initialized");
  },
};

export default plugin;
