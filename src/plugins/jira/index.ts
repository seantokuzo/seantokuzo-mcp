/**
 * jira plugin — Jira Cloud integration for Kuzo MCP.
 *
 * Exposes 11 tools across 4 files:
 *   - tools/tickets.ts (4 tools): get/search/my/update
 *   - tools/transitions.ts (2 tools): list + move-by-name
 *   - tools/subtasks.ts (3 tools): create/list/my-code-reviews
 *   - tools/comments.ts (2 tools): add/list
 *
 * No cross-plugin concerns — Jira↔GitHub workflows are deferred to Phase 5.
 *
 * Required config: JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN
 */

import type { KuzoPlugin } from "../types.js";
import { JiraClient } from "./client.js";
import { setClient, resetClient } from "./state.js";
import { ticketTools } from "./tools/tickets.js";
import { transitionTools } from "./tools/transitions.js";
import { subtaskTools } from "./tools/subtasks.js";
import { commentTools } from "./tools/comments.js";

const plugin: KuzoPlugin = {
  name: "jira",
  description:
    "Jira Cloud integration — tickets, workflow transitions, subtasks, and comments. Uses the Atlassian REST API v3 with Basic auth.",
  version: "1.0.0",
  requiredConfig: ["JIRA_HOST", "JIRA_EMAIL", "JIRA_API_TOKEN"],
  tools: [
    ...ticketTools,
    ...transitionTools,
    ...subtaskTools,
    ...commentTools,
  ],
  async initialize(context) {
    const host = context.config.get("JIRA_HOST");
    const email = context.config.get("JIRA_EMAIL");
    const token = context.config.get("JIRA_API_TOKEN");

    if (!host || !email || !token) {
      throw new Error(
        "JIRA_HOST, JIRA_EMAIL, and JIRA_API_TOKEN are all required. Set them in your .env file or environment.",
      );
    }

    const client = new JiraClient({
      host,
      email,
      token,
      logger: context.logger,
    });

    const { valid, displayName, error } = await client.verifyConnection();
    if (!valid) {
      throw new Error(
        `Jira authentication failed: ${error ?? "unknown error"}`,
      );
    }

    setClient(client);
    context.logger.info(
      `jira plugin initialized (authenticated as ${displayName ?? "unknown user"})`,
    );
  },
  async shutdown() {
    resetClient();
  },
};

export default plugin;
