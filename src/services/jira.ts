/**
 * 🎫 JIRA Service
 * Atlassian Cloud REST API v3 integration
 */

import { getConfig } from "../utils/config.js";
import logger from "../utils/logger.js";
import type {
  JiraTicket,
  JiraTransition,
  JiraSubtask,
  JiraComment,
  CreateJiraSubtaskConfig,
  UpdateJiraTicketConfig,
} from "../types/index.js";

export class JiraService {
  private baseUrl: string;
  private authHeader: string;

  constructor(host?: string, email?: string, apiToken?: string) {
    const config = getConfig();
    const jiraHost = host || config.jira?.host || "";
    const jiraEmail = email || config.jira?.email || "";
    const jiraToken = apiToken || config.jira?.apiToken || "";

    if (!jiraHost || !jiraEmail || !jiraToken) {
      throw new Error(
        "JIRA configuration required. Set JIRA_HOST, JIRA_EMAIL, and JIRA_API_TOKEN in your .env file.",
      );
    }

    // Ensure host doesn't have trailing slash
    this.baseUrl = `https://${jiraHost.replace(/^https?:\/\//, "").replace(/\/$/, "")}/rest/api/3`;

    // Basic auth with email:api_token
    this.authHeader = `Basic ${Buffer.from(`${jiraEmail}:${jiraToken}`).toString("base64")}`;
  }

  /**
   * Make an authenticated request to JIRA API
   */
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
      const errorText = await response.text();
      logger.error(`JIRA API error: ${response.status} - ${errorText}`);
      throw new Error(
        `JIRA API error: ${response.status} - ${response.statusText}`,
      );
    }

    // Some endpoints return no content
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get a ticket by key (e.g., "PROJ-123")
   */
  async getTicket(ticketKey: string): Promise<JiraTicket> {
    logger.debug(`Fetching JIRA ticket: ${ticketKey}`);

    const data = await this.request<any>(
      `/issue/${ticketKey}?expand=transitions`,
    );

    return this.mapTicketResponse(data);
  }

  /**
   * Get available transitions for a ticket
   */
  async getTransitions(ticketKey: string): Promise<JiraTransition[]> {
    logger.debug(`Fetching transitions for: ${ticketKey}`);

    const data = await this.request<{ transitions: any[] }>(
      `/issue/${ticketKey}/transitions`,
    );

    return data.transitions.map((t) => ({
      id: t.id,
      name: t.name,
      to: {
        id: t.to.id,
        name: t.to.name,
        category: t.to.statusCategory?.name || "Unknown",
      },
      hasScreen: t.hasScreen || false,
      isGlobal: t.isGlobal || false,
      isInitial: t.isInitial || false,
      isConditional: t.isConditional || false,
    }));
  }

  /**
   * Transition a ticket to a new status
   */
  async transitionTicket(
    ticketKey: string,
    transitionId: string,
    comment?: string,
  ): Promise<void> {
    logger.debug(
      `Transitioning ${ticketKey} with transition ID: ${transitionId}`,
    );

    const body: any = {
      transition: { id: transitionId },
    };

    if (comment) {
      body.update = {
        comment: [
          {
            add: {
              body: {
                type: "doc",
                version: 1,
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: comment }],
                  },
                ],
              },
            },
          },
        ],
      };
    }

    await this.request(`/issue/${ticketKey}/transitions`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * Move a ticket to a status by name
   */
  async moveTicket(
    ticketKey: string,
    statusName: string,
    comment?: string,
  ): Promise<JiraTransition> {
    const transitions = await this.getTransitions(ticketKey);

    const transition = transitions.find(
      (t) =>
        t.name.toLowerCase() === statusName.toLowerCase() ||
        t.to.name.toLowerCase() === statusName.toLowerCase(),
    );

    if (!transition) {
      const available = transitions.map((t) => t.name).join(", ");
      throw new Error(
        `Cannot transition to "${statusName}". Available transitions: ${available}`,
      );
    }

    await this.transitionTicket(ticketKey, transition.id, comment);
    return transition;
  }

  /**
   * Get subtasks for a ticket
   */
  async getSubtasks(ticketKey: string): Promise<JiraSubtask[]> {
    const ticket = await this.getTicket(ticketKey);
    return ticket.subtasks.map((st) => ({
      id: st.id,
      key: st.key,
      summary: st.summary,
      status: st.status,
      assignee: null, // Basic info from parent doesn't include assignee
      parent: {
        key: ticketKey,
        summary: ticket.summary,
      },
    }));
  }

  /**
   * Create a subtask
   */
  async createSubtask(config: CreateJiraSubtaskConfig): Promise<JiraSubtask> {
    logger.debug(`Creating subtask for: ${config.parentKey}`);

    // First get the parent to know the project
    const parent = await this.getTicket(config.parentKey);

    const body = {
      fields: {
        project: { key: parent.project.key },
        parent: { key: config.parentKey },
        summary: config.summary,
        issuetype: { name: "Sub-task" },
        ...(config.description && {
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: config.description }],
              },
            ],
          },
        }),
        ...(config.assigneeAccountId && {
          assignee: { accountId: config.assigneeAccountId },
        }),
      },
    };

    const data = await this.request<any>("/issue", {
      method: "POST",
      body: JSON.stringify(body),
    });

    return {
      id: data.id,
      key: data.key,
      summary: config.summary,
      status: "To Do",
      assignee: config.assigneeAccountId || null,
      parent: {
        key: config.parentKey,
        summary: parent.summary,
      },
    };
  }

  /**
   * Update a ticket (summary, description, etc.)
   */
  async updateTicket(config: UpdateJiraTicketConfig): Promise<void> {
    logger.debug(`Updating ticket: ${config.ticketKey}`);

    const fields: any = {};

    if (config.summary) {
      fields.summary = config.summary;
    }

    if (config.description) {
      fields.description = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: config.description }],
          },
        ],
      };
    }

    if (config.labels) {
      fields.labels = config.labels;
    }

    if (config.assigneeAccountId) {
      fields.assignee = { accountId: config.assigneeAccountId };
    }

    await this.request(`/issue/${config.ticketKey}`, {
      method: "PUT",
      body: JSON.stringify({ fields }),
    });
  }

  /**
   * Append text to an existing description
   */
  async appendToDescription(
    ticketKey: string,
    additionalText: string,
  ): Promise<void> {
    logger.debug(`Appending to description of: ${ticketKey}`);

    const ticket = await this.getTicket(ticketKey);
    const existingDescription = ticket.description || "";

    const newDescription = existingDescription
      ? `${existingDescription}\n\n${additionalText}`
      : additionalText;

    await this.updateTicket({
      ticketKey,
      description: newDescription,
    });
  }

  /**
   * Add a comment to a ticket
   */
  async addComment(
    ticketKey: string,
    commentText: string,
  ): Promise<JiraComment> {
    logger.debug(`Adding comment to: ${ticketKey}`);

    const body = {
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: commentText }],
          },
        ],
      },
    };

    const data = await this.request<any>(`/issue/${ticketKey}/comment`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    return {
      id: data.id,
      body: commentText,
      author: {
        accountId: data.author?.accountId || "",
        displayName: data.author?.displayName || "Unknown",
      },
      created: data.created,
      updated: data.updated,
    };
  }

  /**
   * Get comments on a ticket
   */
  async getComments(ticketKey: string): Promise<JiraComment[]> {
    logger.debug(`Fetching comments for: ${ticketKey}`);

    const data = await this.request<{ comments: any[] }>(
      `/issue/${ticketKey}/comment`,
    );

    return data.comments.map((c) => ({
      id: c.id,
      body: this.extractTextFromADF(c.body),
      author: {
        accountId: c.author?.accountId || "",
        displayName: c.author?.displayName || "Unknown",
      },
      created: c.created,
      updated: c.updated,
    }));
  }

  /**
   * Search for tickets assigned to current user
   */
  async getMyTickets(projectKey?: string): Promise<JiraTicket[]> {
    logger.debug("Fetching tickets assigned to current user");

    let jql =
      "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC";
    if (projectKey) {
      jql = `project = ${projectKey} AND ${jql}`;
    }

    const data = await this.request<{ issues: any[] }>(
      `/search?jql=${encodeURIComponent(jql)}&maxResults=50`,
    );

    return data.issues.map((issue) => this.mapTicketResponse(issue));
  }

  /**
   * Search for tickets with a JQL query
   */
  async searchTickets(
    jql: string,
    maxResults: number = 50,
  ): Promise<JiraTicket[]> {
    logger.debug(`Searching tickets with JQL: ${jql}`);

    const data = await this.request<{ issues: any[] }>(
      `/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}`,
    );

    return data.issues.map((issue) => this.mapTicketResponse(issue));
  }

  /**
   * Get my code review subtasks (subtasks assigned to me that are reviews)
   */
  async getMyCodeReviews(projectKey?: string): Promise<JiraSubtask[]> {
    logger.debug("Fetching code review subtasks assigned to current user");

    let jql =
      'assignee = currentUser() AND issuetype = Sub-task AND summary ~ "review" AND resolution = Unresolved ORDER BY updated DESC';
    if (projectKey) {
      jql = `project = ${projectKey} AND ${jql}`;
    }

    const data = await this.request<{ issues: any[] }>(
      `/search?jql=${encodeURIComponent(jql)}&maxResults=50`,
    );

    return data.issues.map((issue) => ({
      id: issue.id,
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name || "Unknown",
      assignee: issue.fields.assignee?.displayName || null,
      parent: {
        key: issue.fields.parent?.key || "",
        summary: issue.fields.parent?.fields?.summary || "",
      },
    }));
  }

  /**
   * Verify connection and get current user
   */
  async verifyConnection(): Promise<{
    valid: boolean;
    displayName?: string;
    accountId?: string;
    user?: string;
    error?: string;
  }> {
    try {
      const data = await this.request<{
        displayName: string;
        emailAddress: string;
        accountId: string;
      }>("/myself");
      return {
        valid: true,
        displayName: data.displayName,
        accountId: data.accountId,
        user: data.displayName || data.emailAddress,
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Extract plain text from Atlassian Document Format (ADF)
   */
  private extractTextFromADF(adf: any): string {
    if (!adf || typeof adf === "string") return adf || "";

    if (adf.type === "text") return adf.text || "";

    if (adf.content && Array.isArray(adf.content)) {
      return adf.content
        .map((node: any) => this.extractTextFromADF(node))
        .join("");
    }

    return "";
  }

  /**
   * Map JIRA API response to our JiraTicket type
   */
  private mapTicketResponse(data: any): JiraTicket {
    const fields = data.fields || {};

    return {
      id: data.id,
      key: data.key,
      summary: fields.summary || "",
      description: this.extractTextFromADF(fields.description),
      status: {
        id: fields.status?.id || "",
        name: fields.status?.name || "Unknown",
        category: fields.status?.statusCategory?.name || "Unknown",
      },
      assignee: fields.assignee
        ? {
            accountId: fields.assignee.accountId,
            displayName: fields.assignee.displayName,
            emailAddress: fields.assignee.emailAddress,
          }
        : null,
      reporter: fields.reporter
        ? {
            accountId: fields.reporter.accountId,
            displayName: fields.reporter.displayName,
          }
        : null,
      priority: fields.priority
        ? {
            id: fields.priority.id,
            name: fields.priority.name,
          }
        : null,
      issueType: {
        id: fields.issuetype?.id || "",
        name: fields.issuetype?.name || "Unknown",
        subtask: fields.issuetype?.subtask || false,
      },
      project: {
        id: fields.project?.id || "",
        key: fields.project?.key || "",
        name: fields.project?.name || "",
      },
      parent: fields.parent
        ? {
            id: fields.parent.id,
            key: fields.parent.key,
            summary: fields.parent.fields?.summary || "",
          }
        : undefined,
      subtasks: (fields.subtasks || []).map((st: any) => ({
        id: st.id,
        key: st.key,
        summary: st.fields?.summary || "",
        status: st.fields?.status?.name || "Unknown",
      })),
      created: fields.created || "",
      updated: fields.updated || "",
      labels: fields.labels || [],
      components: (fields.components || []).map((c: any) => ({
        id: c.id,
        name: c.name,
      })),
    };
  }
}

// Singleton instance
let jiraServiceInstance: JiraService | null = null;

export function getJiraService(): JiraService {
  if (!jiraServiceInstance) {
    jiraServiceInstance = new JiraService();
  }
  return jiraServiceInstance;
}

export default JiraService;
