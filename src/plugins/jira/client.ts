/**
 * JiraClient — thin wrapper around the Atlassian Cloud REST API v3.
 *
 * No singleton, no global config. Constructed with explicit host, email, and
 * API token (plus an optional logger) by the plugin in `initialize()`.
 *
 * Authentication: HTTP Basic with `email:api_token`. See
 * https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/
 */

import type { PluginLogger } from "../types.js";
import { extractTextFromADF, textToADF } from "./adf.js";
import type {
  JiraTicket,
  JiraTransition,
  JiraSubtask,
  JiraComment,
  CreateSubtaskConfig,
  UpdateTicketConfig,
} from "./types.js";

export interface JiraClientOptions {
  /** Jira Cloud host, e.g. "yourorg.atlassian.net" (scheme optional) */
  host: string;
  email: string;
  token: string;
  logger?: PluginLogger;
}

/** No-op logger used when none is supplied */
const noopLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// ============================================================================
// Raw API response shapes (subset — only fields we actually read)
// ============================================================================

interface JiraUserRaw {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
}

interface JiraStatusRaw {
  id?: string;
  name?: string;
  statusCategory?: { name?: string };
}

interface JiraFieldsRaw {
  summary?: string;
  description?: unknown;
  status?: JiraStatusRaw;
  assignee?: JiraUserRaw | null;
  reporter?: JiraUserRaw | null;
  priority?: { id?: string; name?: string } | null;
  issuetype?: { id?: string; name?: string; subtask?: boolean };
  project?: { id?: string; key?: string; name?: string };
  parent?: {
    id?: string;
    key?: string;
    fields?: { summary?: string };
  };
  subtasks?: Array<{
    id?: string;
    key?: string;
    fields?: { summary?: string; status?: { name?: string } };
  }>;
  created?: string;
  updated?: string;
  labels?: string[];
  components?: Array<{ id?: string; name?: string }>;
}

interface JiraIssueRaw {
  id?: string;
  key?: string;
  fields?: JiraFieldsRaw;
}

interface JiraTransitionRaw {
  id?: string;
  name?: string;
  to?: {
    id?: string;
    name?: string;
    statusCategory?: { name?: string };
  };
  hasScreen?: boolean;
  isGlobal?: boolean;
  isInitial?: boolean;
  isConditional?: boolean;
}

interface JiraCommentRaw {
  id?: string;
  body?: unknown;
  author?: JiraUserRaw;
  created?: string;
  updated?: string;
}

interface JiraMyselfRaw {
  displayName?: string;
  accountId?: string;
  emailAddress?: string;
}

// ============================================================================
// Client
// ============================================================================

export class JiraClient {
  readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly logger: PluginLogger;

  constructor(options: JiraClientOptions) {
    if (!options.host || !options.email || !options.token) {
      throw new Error("JiraClient requires host, email, and token");
    }

    // Normalize: drop scheme and trailing slash, then append /rest/api/3
    const normalizedHost = options.host
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
    this.baseUrl = `https://${normalizedHost}/rest/api/3`;

    this.authHeader = `Basic ${Buffer.from(
      `${options.email}:${options.token}`,
    ).toString("base64")}`;

    this.logger = options.logger ?? noopLogger;
  }

  // ==========================================================================
  // Internal — request helper
  // ==========================================================================

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      this.logger.error(
        `Jira API error: ${response.status} ${response.statusText}`,
        { endpoint, errorText },
      );
      throw new Error(
        `Jira API error: ${response.status} ${response.statusText}${
          errorText ? ` — ${errorText}` : ""
        }`,
      );
    }

    // 204 No Content — common for PUT/POST success
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // ==========================================================================
  // Auth
  // ==========================================================================

  async getCurrentUser(): Promise<JiraMyselfRaw> {
    return this.request<JiraMyselfRaw>("/myself");
  }

  async verifyConnection(): Promise<{
    valid: boolean;
    displayName?: string;
    accountId?: string;
    error?: string;
  }> {
    try {
      const data = await this.getCurrentUser();
      return {
        valid: true,
        displayName: data.displayName,
        accountId: data.accountId,
      };
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  // ==========================================================================
  // Tickets
  // ==========================================================================

  async getTicket(ticketKey: string): Promise<JiraTicket> {
    this.logger.debug(`Fetching ticket ${ticketKey}`);
    const data = await this.request<JiraIssueRaw>(
      `/issue/${encodeURIComponent(ticketKey)}?expand=transitions`,
    );
    return this.mapTicketResponse(data);
  }

  async searchTickets(
    jql: string,
    maxResults: number = 50,
  ): Promise<JiraTicket[]> {
    this.logger.debug("Searching tickets", { jql, maxResults });

    const data = await this.request<{ issues?: JiraIssueRaw[] }>(
      "/search/jql",
      {
        method: "POST",
        body: JSON.stringify({ jql, maxResults }),
      },
    );

    if (!data.issues) {
      this.logger.warn("No issues field in Jira search response");
      return [];
    }
    return data.issues.map((issue) => this.mapTicketResponse(issue));
  }

  async getMyTickets(projectKey?: string): Promise<JiraTicket[]> {
    let jql =
      "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC";
    if (projectKey) {
      jql = `project = ${projectKey} AND ${jql}`;
    }
    return this.searchTickets(jql);
  }

  async updateTicket(config: UpdateTicketConfig): Promise<void> {
    // Log only metadata — description/summary may contain user content.
    this.logger.debug("Updating ticket", {
      ticketKey: config.ticketKey,
      fields: {
        summary: config.summary !== undefined,
        description: config.description !== undefined,
        labels: config.labels !== undefined,
        assignee: config.assigneeAccountId !== undefined,
      },
    });

    const fields: Record<string, unknown> = {};

    if (config.summary) {
      fields.summary = config.summary;
    }
    if (config.description) {
      fields.description = textToADF(config.description);
    }
    if (config.labels) {
      fields.labels = config.labels;
    }
    if (config.assigneeAccountId) {
      fields.assignee = { accountId: config.assigneeAccountId };
    }

    if (Object.keys(fields).length === 0) {
      throw new Error(
        "updateTicket called with no updatable fields. Provide at least one of: summary, description, labels, assigneeAccountId.",
      );
    }

    await this.request(`/issue/${encodeURIComponent(config.ticketKey)}`, {
      method: "PUT",
      body: JSON.stringify({ fields }),
    });
  }

  // ==========================================================================
  // Transitions
  // ==========================================================================

  async getTransitions(ticketKey: string): Promise<JiraTransition[]> {
    this.logger.debug(`Fetching transitions for ${ticketKey}`);
    const data = await this.request<{ transitions?: JiraTransitionRaw[] }>(
      `/issue/${encodeURIComponent(ticketKey)}/transitions`,
    );

    return (data.transitions ?? []).map((t) => ({
      id: t.id ?? "",
      name: t.name ?? "",
      to: {
        id: t.to?.id ?? "",
        name: t.to?.name ?? "",
        category: t.to?.statusCategory?.name ?? "Unknown",
      },
      hasScreen: t.hasScreen ?? false,
      isGlobal: t.isGlobal ?? false,
      isInitial: t.isInitial ?? false,
      isConditional: t.isConditional ?? false,
    }));
  }

  async transitionTicket(
    ticketKey: string,
    transitionId: string,
    comment?: string,
  ): Promise<void> {
    this.logger.debug("Transitioning ticket", {
      ticketKey,
      transitionId,
      hasComment: comment !== undefined,
    });

    const body: Record<string, unknown> = {
      transition: { id: transitionId },
    };

    if (comment) {
      body.update = {
        comment: [{ add: { body: textToADF(comment) } }],
      };
    }

    await this.request(
      `/issue/${encodeURIComponent(ticketKey)}/transitions`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  }

  /**
   * High-level: move a ticket to a status by name.
   *
   * Looks up available transitions and picks the one whose name OR target
   * status name matches (case-insensitive). Throws with the list of available
   * transitions if no match is found.
   */
  async moveTicket(
    ticketKey: string,
    statusName: string,
    comment?: string,
  ): Promise<JiraTransition> {
    const transitions = await this.getTransitions(ticketKey);

    const target = transitions.find(
      (t) =>
        t.name.toLowerCase() === statusName.toLowerCase() ||
        t.to.name.toLowerCase() === statusName.toLowerCase(),
    );

    if (!target) {
      const available = transitions
        .map((t) => `"${t.name}" → ${t.to.name}`)
        .join(", ");
      throw new Error(
        `No transition matches "${statusName}" for ${ticketKey}. Available: ${
          available || "(none)"
        }`,
      );
    }

    await this.transitionTicket(ticketKey, target.id, comment);
    return target;
  }

  // ==========================================================================
  // Subtasks
  // ==========================================================================

  async getSubtasks(ticketKey: string): Promise<JiraSubtask[]> {
    // Parent issue's `subtasks` field holds the list — no separate endpoint.
    const ticket = await this.getTicket(ticketKey);
    return ticket.subtasks.map((st) => ({
      id: st.id,
      key: st.key,
      summary: st.summary,
      status: st.status,
      // Parent's subtasks array doesn't include assignee. Callers who need
      // assignee per subtask should getTicket(subtaskKey) individually.
      assignee: null,
      parent: {
        key: ticket.key,
        summary: ticket.summary,
      },
    }));
  }

  async createSubtask(config: CreateSubtaskConfig): Promise<JiraSubtask> {
    this.logger.debug("Creating subtask", {
      parentKey: config.parentKey,
      hasDescription: config.description !== undefined,
      hasAssignee: config.assigneeAccountId !== undefined,
    });

    // Need the parent to know which project to create the subtask under.
    const parent = await this.getTicket(config.parentKey);

    const fields: Record<string, unknown> = {
      project: { key: parent.project.key },
      parent: { key: config.parentKey },
      summary: config.summary,
      issuetype: { name: "Sub-task" },
    };

    if (config.description) {
      fields.description = textToADF(config.description);
    }
    if (config.assigneeAccountId) {
      fields.assignee = { accountId: config.assigneeAccountId };
    }

    const data = await this.request<{ id?: string; key?: string }>("/issue", {
      method: "POST",
      body: JSON.stringify({ fields }),
    });

    return {
      id: data.id ?? "",
      key: data.key ?? "",
      summary: config.summary,
      status: "To Do",
      assignee: config.assigneeAccountId ?? null,
      parent: {
        key: config.parentKey,
        summary: parent.summary,
      },
    };
  }

  async getMyCodeReviews(projectKey?: string): Promise<JiraSubtask[]> {
    let jql =
      'assignee = currentUser() AND issuetype = Sub-task AND summary ~ "review" AND resolution = Unresolved ORDER BY updated DESC';
    if (projectKey) {
      jql = `project = ${projectKey} AND ${jql}`;
    }

    const data = await this.request<{ issues?: JiraIssueRaw[] }>(
      "/search/jql",
      {
        method: "POST",
        body: JSON.stringify({ jql, maxResults: 50 }),
      },
    );

    return (data.issues ?? []).map((issue) => {
      const fields = issue.fields ?? {};
      return {
        id: issue.id ?? "",
        key: issue.key ?? "",
        summary: fields.summary ?? "",
        status: fields.status?.name ?? "Unknown",
        assignee: fields.assignee?.displayName ?? null,
        parent: {
          key: fields.parent?.key ?? "",
          summary: fields.parent?.fields?.summary ?? "",
        },
      };
    });
  }

  // ==========================================================================
  // Comments
  // ==========================================================================

  async addComment(
    ticketKey: string,
    commentText: string,
  ): Promise<JiraComment> {
    this.logger.debug("Adding comment", {
      ticketKey,
      length: commentText.length,
    });

    const data = await this.request<JiraCommentRaw>(
      `/issue/${encodeURIComponent(ticketKey)}/comment`,
      {
        method: "POST",
        body: JSON.stringify({ body: textToADF(commentText) }),
      },
    );

    return {
      id: data.id ?? "",
      body: commentText,
      author: {
        accountId: data.author?.accountId ?? "",
        displayName: data.author?.displayName ?? "Unknown",
      },
      created: data.created ?? "",
      updated: data.updated ?? "",
    };
  }

  async getComments(ticketKey: string): Promise<JiraComment[]> {
    this.logger.debug(`Fetching comments for ${ticketKey}`);
    const data = await this.request<{ comments?: JiraCommentRaw[] }>(
      `/issue/${encodeURIComponent(ticketKey)}/comment`,
    );

    return (data.comments ?? []).map((c) => ({
      id: c.id ?? "",
      body: extractTextFromADF(c.body),
      author: {
        accountId: c.author?.accountId ?? "",
        displayName: c.author?.displayName ?? "Unknown",
      },
      created: c.created ?? "",
      updated: c.updated ?? "",
    }));
  }

  // ==========================================================================
  // Private mappers
  // ==========================================================================

  private mapTicketResponse(raw: JiraIssueRaw): JiraTicket {
    const fields = raw.fields ?? {};

    return {
      id: raw.id ?? "",
      key: raw.key ?? "",
      summary: fields.summary ?? "",
      description: extractTextFromADF(fields.description),
      status: {
        id: fields.status?.id ?? "",
        name: fields.status?.name ?? "Unknown",
        category: fields.status?.statusCategory?.name ?? "Unknown",
      },
      assignee: fields.assignee
        ? {
            accountId: fields.assignee.accountId ?? "",
            displayName: fields.assignee.displayName ?? "Unknown",
            emailAddress: fields.assignee.emailAddress,
          }
        : null,
      reporter: fields.reporter
        ? {
            accountId: fields.reporter.accountId ?? "",
            displayName: fields.reporter.displayName ?? "Unknown",
          }
        : null,
      priority: fields.priority
        ? {
            id: fields.priority.id ?? "",
            name: fields.priority.name ?? "Unknown",
          }
        : null,
      issueType: {
        id: fields.issuetype?.id ?? "",
        name: fields.issuetype?.name ?? "Unknown",
        subtask: fields.issuetype?.subtask ?? false,
      },
      project: {
        id: fields.project?.id ?? "",
        key: fields.project?.key ?? "",
        name: fields.project?.name ?? "",
      },
      parent: fields.parent
        ? {
            id: fields.parent.id ?? "",
            key: fields.parent.key ?? "",
            summary: fields.parent.fields?.summary ?? "",
          }
        : undefined,
      subtasks: (fields.subtasks ?? []).map((st) => ({
        id: st.id ?? "",
        key: st.key ?? "",
        summary: st.fields?.summary ?? "",
        status: st.fields?.status?.name ?? "Unknown",
      })),
      created: fields.created ?? "",
      updated: fields.updated ?? "",
      labels: fields.labels ?? [],
      components: (fields.components ?? []).map((c) => ({
        id: c.id ?? "",
        name: c.name ?? "",
      })),
    };
  }
}
