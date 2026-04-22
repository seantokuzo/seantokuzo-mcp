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
 * Credentials: JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN via credential broker (access: "client")
 */

import { createRequire } from "node:module";
import type { KuzoPluginV2 } from "@kuzo-mcp/types";
import type { JiraClient } from "./client.js";
import { setClient, resetClient } from "./state.js";
import { ticketTools } from "./tools/tickets.js";
import { transitionTools } from "./tools/transitions.js";
import { subtaskTools } from "./tools/subtasks.js";
import { commentTools } from "./tools/comments.js";

const pkgJson = createRequire(import.meta.url)("../package.json") as { version: string };

const plugin: KuzoPluginV2 = {
  name: "jira",
  description:
    "Jira Cloud integration — tickets, workflow transitions, subtasks, and comments. Uses the Atlassian REST API v3 with Basic auth.",
  version: pkgJson.version,
  permissionModel: 1,
  capabilities: [
    {
      kind: "credentials",
      env: "JIRA_HOST",
      access: "client",
      reason: "Jira Cloud instance hostname for API base URL",
    },
    {
      kind: "credentials",
      env: "JIRA_EMAIL",
      access: "client",
      reason: "Email address for Basic auth with the Jira API",
    },
    {
      kind: "credentials",
      env: "JIRA_API_TOKEN",
      access: "client",
      reason: "API token for Basic auth with the Jira API",
    },
    {
      kind: "network",
      domain: "*.atlassian.net",
      reason: "All Jira Cloud API calls",
    },
  ],
  tools: [
    ...ticketTools,
    ...transitionTools,
    ...subtaskTools,
    ...commentTools,
  ],
  async initialize(context) {
    // Get pre-authenticated client from the credential broker.
    // The factory reads JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN and constructs JiraClient.
    const client = context.credentials.getClient<JiraClient>("jira");
    if (!client) {
      throw new Error(
        "Failed to create Jira client — JIRA_HOST, JIRA_EMAIL, and JIRA_API_TOKEN may be missing. Set them in your .env file or environment.",
      );
    }

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
