/**
 * git-context plugin — detects local git repo/branch/status.
 *
 * No external config required. Other plugins call `get_git_context` via
 * `context.callTool()` to resolve repo/branch automatically.
 */

import type { KuzoPlugin } from "../types.js";
import { getGitContextTool } from "./tools/context.js";
import { gitContextResource } from "./resources/context.js";

const plugin: KuzoPlugin = {
  name: "git-context",
  description:
    "Detects the current git repository, branch, and working tree state from the local filesystem",
  version: "1.0.0",
  requiredConfig: [],
  tools: [getGitContextTool],
  resources: [gitContextResource],
  async initialize(context) {
    context.logger.info("git-context plugin initialized");
  },
};

export default plugin;
