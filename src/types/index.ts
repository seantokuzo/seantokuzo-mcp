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
