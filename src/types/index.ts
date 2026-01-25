/**
 * 🎯 Core Types for Sean's MCP Server
 * Because TypeScript is the way
 */

// ============================================
// GitHub Types
// ============================================

export interface GitHubRepo {
  owner: string;
  repo: string;
}

export interface PullRequestConfig {
  repo: GitHubRepo;
  title: string;
  body: string;
  head: string; // Source branch
  base: string; // Target branch (usually main)
  draft?: boolean;
}

export interface PullRequestUpdateConfig {
  repo: GitHubRepo;
  pullNumber: number;
  title?: string;
  body?: string;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  head: {
    ref: string;
    sha: string;
  };
  base: {
    ref: string;
  };
  user: {
    login: string;
  } | null;
  created_at: string;
  updated_at: string;
  draft: boolean;
  mergeable: boolean | null;
  additions: number;
  deletions: number;
  changed_files: number;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface BranchInfo {
  name: string;
  sha: string;
  protected: boolean;
}

// ============================================
// MCP Types
// ============================================

export interface MCPToolInput {
  [key: string]: unknown;
}

export interface MCPToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  message: string;
}

// ============================================
// CLI Types
// ============================================

export type Personality = "professional" | "chaotic" | "zen";

export interface CLIConfig {
  personality: Personality;
  githubToken: string;
  githubUsername: string;
}

export interface PRCreationInput {
  repoUrl?: string;
  owner?: string;
  repo?: string;
  sourceBranch: string;
  targetBranch: string;
  title?: string;
  description?: string;
  userContext?: string; // Additional context from the user
  draft?: boolean;
}

export interface PRUpdateInput {
  repoUrl?: string;
  owner?: string;
  repo?: string;
  pullNumber?: number;
  title?: string;
  description?: string;
  userContext?: string;
}

// ============================================
// Webhook Types
// ============================================

export interface WebhookPayload {
  action?: string;
  ref?: string;
  before?: string;
  after?: string;
  repository?: {
    name: string;
    full_name: string;
    owner: {
      login: string;
    };
  };
  sender?: {
    login: string;
  };
  commits?: Array<{
    id: string;
    message: string;
    author: {
      name: string;
      email: string;
    };
  }>;
  pull_request?: {
    number: number;
    title: string;
    body: string;
    head: {
      ref: string;
    };
  };
}

// ============================================
// AI/Description Generation Types
// ============================================

export interface PRDescriptionContext {
  commits: CommitInfo[];
  diffStats: {
    additions: number;
    deletions: number;
    changedFiles: number;
  };
  userContext?: string;
  existingDescription?: string;
}

export interface GeneratedPRDescription {
  title: string;
  body: string;
  summary: string;
}

// ============================================
// Repository Types
// ============================================

export interface RepoInfo {
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  has_issues: boolean;
  has_wiki: boolean;
  has_projects: boolean;
  open_issues_count: number;
  stargazers_count: number;
  forks_count: number;
  created_at: string;
  updated_at: string;
  owner: {
    login: string;
  };
}

export interface CreateRepoConfig {
  name: string;
  description?: string;
  private?: boolean;
  auto_init?: boolean;
  gitignore_template?: string;
  license_template?: string;
  readme_content?: string;
}

export interface UpdateRepoConfig {
  repo: GitHubRepo;
  name?: string;
  description?: string;
  private?: boolean;
  has_issues?: boolean;
  has_wiki?: boolean;
  has_projects?: boolean;
}

// ============================================
// PR Review Types
// ============================================

export interface PRFileDiff {
  filename: string;
  status:
    | "added"
    | "removed"
    | "modified"
    | "renamed"
    | "copied"
    | "changed"
    | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  blob_url: string;
  raw_url: string;
  contents_url: string;
  previous_filename?: string;
}

export interface PRReviewComment {
  id: number;
  body: string;
  path: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  commit_id: string;
  user: {
    login: string;
  };
  created_at: string;
  updated_at: string;
  in_reply_to_id?: number;
}

export interface PRReview {
  id: number;
  user: {
    login: string;
  };
  body: string;
  state:
    | "APPROVED"
    | "CHANGES_REQUESTED"
    | "COMMENTED"
    | "PENDING"
    | "DISMISSED";
  submitted_at: string;
  commit_id: string | null;
}

export interface SubmitReviewConfig {
  repo: GitHubRepo;
  pullNumber: number;
  body: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  comments?: Array<{
    path: string;
    line: number;
    body: string;
    side?: "LEFT" | "RIGHT";
  }>;
}

export interface CodeConcern {
  file: string;
  line: number;
  severity: "low" | "medium" | "high" | "critical";
  type: "security" | "performance" | "bug" | "style" | "complexity" | "other";
  message: string;
  suggestion?: string;
}

// ============================================
// JIRA Types
// ============================================

export interface JiraConfig {
  host: string;
  email: string;
  apiToken: string;
}

export interface JiraTicket {
  id: string;
  key: string;
  summary: string;
  description: string | null;
  status: {
    id: string;
    name: string;
    category: string;
  };
  assignee: {
    accountId: string;
    displayName: string;
    emailAddress?: string;
  } | null;
  reporter: {
    accountId: string;
    displayName: string;
  } | null;
  priority: {
    id: string;
    name: string;
  } | null;
  issueType: {
    id: string;
    name: string;
    subtask: boolean;
  };
  project: {
    id: string;
    key: string;
    name: string;
  };
  parent?: {
    id: string;
    key: string;
    summary: string;
  };
  subtasks: Array<{
    id: string;
    key: string;
    summary: string;
    status: string;
  }>;
  created: string;
  updated: string;
  labels: string[];
  components: Array<{
    id: string;
    name: string;
  }>;
  customFields?: Record<string, unknown>;
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

export interface JiraWorkflow {
  id: string;
  name: string;
  description?: string;
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

export interface CreateJiraSubtaskConfig {
  parentKey: string;
  summary: string;
  description?: string;
  assigneeAccountId?: string;
}

export interface UpdateJiraTicketConfig {
  ticketKey: string;
  summary?: string;
  description?: string;
  appendDescription?: string;
  labels?: string[];
  assigneeAccountId?: string;
}
