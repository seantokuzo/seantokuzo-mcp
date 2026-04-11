/**
 * GitHub plugin types — owned by the github plugin, not a flat types file.
 */

export interface GitHubRepo {
  owner: string;
  repo: string;
}

export interface PullRequestConfig {
  repo: GitHubRepo;
  title: string;
  body: string;
  head: string;
  base: string;
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
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string } | null;
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

export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface DiffStats {
  additions: number;
  deletions: number;
  changedFiles: number;
}

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
  owner: { login: string };
}

export interface CreateRepoConfig {
  name: string;
  description?: string;
  private?: boolean;
  auto_init?: boolean;
  gitignore_template?: string;
  license_template?: string;
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

export interface PRReview {
  id: number;
  user: { login: string };
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

export interface PRReviewComment {
  id: number;
  body: string;
  path: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  commit_id: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
  in_reply_to_id?: number;
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

/**
 * Shape returned by the git-context plugin's `get_git_context` tool.
 * Loose contract — cross-plugin types are informally defined until Phase 2.5
 * formalizes them.
 */
export interface GitContextResult {
  success: boolean;
  message?: string;
  data: {
    isGitRepo: boolean;
    repository?: string | null;
    owner?: string | null;
    repo?: string | null;
    currentBranch?: string | null;
    defaultBranch?: string | null;
    hasUncommittedChanges?: boolean;
    hasUnpushedCommits?: boolean;
    changedFiles?: string[];
    recentCommits?: Array<{ sha: string; message: string }>;
  };
}
