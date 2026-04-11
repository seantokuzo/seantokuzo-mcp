/**
 * Jira plugin types — owned by the jira plugin, not a flat types file.
 *
 * These are the types exposed externally by the plugin. Raw Jira API response
 * shapes stay as private interfaces in client.ts.
 */

export interface JiraStatus {
  id: string;
  name: string;
  category: string;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

export interface JiraReporter {
  accountId: string;
  displayName: string;
}

export interface JiraPriority {
  id: string;
  name: string;
}

export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface JiraTicketParent {
  id: string;
  key: string;
  summary: string;
}

export interface JiraComponent {
  id: string;
  name: string;
}

export interface JiraSubtaskSummary {
  id: string;
  key: string;
  summary: string;
  status: string;
}

export interface JiraTicket {
  id: string;
  key: string;
  summary: string;
  description: string;
  status: JiraStatus;
  assignee: JiraUser | null;
  reporter: JiraReporter | null;
  priority: JiraPriority | null;
  issueType: JiraIssueType;
  project: JiraProject;
  parent?: JiraTicketParent;
  subtasks: JiraSubtaskSummary[];
  created: string;
  updated: string;
  labels: string[];
  components: JiraComponent[];
}

export interface JiraTransition {
  id: string;
  name: string;
  to: {
    id: string;
    name: string;
    category: string;
  };
  hasScreen: boolean;
  isGlobal: boolean;
  isInitial: boolean;
  isConditional: boolean;
}

export interface JiraSubtask {
  id: string;
  key: string;
  summary: string;
  status: string;
  assignee: string | null;
  parent: {
    key: string;
    summary: string;
  };
}

export interface JiraComment {
  id: string;
  body: string;
  author: {
    accountId: string;
    displayName: string;
  };
  created: string;
  updated: string;
}

export interface CreateSubtaskConfig {
  parentKey: string;
  summary: string;
  description?: string;
  assigneeAccountId?: string;
}

export interface UpdateTicketConfig {
  ticketKey: string;
  summary?: string;
  description?: string;
  labels?: string[];
  assigneeAccountId?: string;
}
