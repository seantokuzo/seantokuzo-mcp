/**
 * 🐙 GitHub Service
 * All the GitHub API magic happens here
 */

import { Octokit } from "@octokit/rest";
import { getConfig } from "../utils/config.js";
import logger from "../utils/logger.js";
import type {
  GitHubRepo,
  PullRequestConfig,
  PullRequestUpdateConfig,
  PullRequestInfo,
  CommitInfo,
  BranchInfo,
  RepoInfo,
  CreateRepoConfig,
  UpdateRepoConfig,
} from "../types/index.js";

export class GitHubService {
  private octokit: Octokit;

  constructor(token?: string) {
    const config = getConfig();
    const authToken = token || config.github.token;

    if (!authToken) {
      throw new Error(
        "GitHub token is required. Set GITHUB_TOKEN in your .env file.",
      );
    }

    this.octokit = new Octokit({ auth: authToken });
  }

  /**
   * Parse a GitHub URL or owner/repo string into components
   */
  parseRepoIdentifier(input: string): GitHubRepo {
    // Handle full URLs: https://github.com/owner/repo or git@github.com:owner/repo.git
    const urlMatch = input.match(/github\.com[/:]([\w-]+)\/([\w-]+)/);
    if (urlMatch) {
      return { owner: urlMatch[1]!, repo: urlMatch[2]!.replace(/\.git$/, "") };
    }

    // Handle owner/repo format
    const parts = input.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1] };
    }

    throw new Error(
      `Invalid repository identifier: ${input}. Use owner/repo or a GitHub URL.`,
    );
  }

  /**
   * Get the authenticated user
   */
  async getAuthenticatedUser(): Promise<string> {
    const { data } = await this.octokit.users.getAuthenticated();
    return data.login;
  }

  /**
   * List branches for a repository
   */
  async listBranches(repo: GitHubRepo): Promise<BranchInfo[]> {
    const { data } = await this.octokit.repos.listBranches({
      owner: repo.owner,
      repo: repo.repo,
      per_page: 100,
    });

    return data.map((branch) => ({
      name: branch.name,
      sha: branch.commit.sha,
      protected: branch.protected,
    }));
  }

  /**
   * Get commits on a branch (compared to base)
   */
  async getCommitsBetween(
    repo: GitHubRepo,
    base: string,
    head: string,
  ): Promise<CommitInfo[]> {
    try {
      const { data } = await this.octokit.repos.compareCommits({
        owner: repo.owner,
        repo: repo.repo,
        base,
        head,
      });

      return data.commits.map((commit) => ({
        sha: commit.sha,
        message: commit.commit.message,
        author: commit.commit.author?.name || commit.author?.login || "Unknown",
        date: commit.commit.author?.date || "",
      }));
    } catch (error) {
      logger.warn(`Could not compare commits: ${error}`);
      return [];
    }
  }

  /**
   * Get diff stats between two refs
   */
  async getDiffStats(
    repo: GitHubRepo,
    base: string,
    head: string,
  ): Promise<{ additions: number; deletions: number; changedFiles: number }> {
    try {
      const { data } = await this.octokit.repos.compareCommits({
        owner: repo.owner,
        repo: repo.repo,
        base,
        head,
      });

      return {
        additions: data.files?.reduce((sum, f) => sum + f.additions, 0) || 0,
        deletions: data.files?.reduce((sum, f) => sum + f.deletions, 0) || 0,
        changedFiles: data.files?.length || 0,
      };
    } catch (error) {
      logger.warn(`Could not get diff stats: ${error}`);
      return { additions: 0, deletions: 0, changedFiles: 0 };
    }
  }

  /**
   * Get files changed between two refs
   */
  async getChangedFiles(
    repo: GitHubRepo,
    base: string,
    head: string,
  ): Promise<
    Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
    }>
  > {
    try {
      const { data } = await this.octokit.repos.compareCommits({
        owner: repo.owner,
        repo: repo.repo,
        base,
        head,
      });

      return (data.files || []).map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
      }));
    } catch (error) {
      logger.warn(`Could not get changed files: ${error}`);
      return [];
    }
  }

  /**
   * Create a new pull request
   */
  async createPullRequest(config: PullRequestConfig): Promise<PullRequestInfo> {
    logger.debug("Creating PR with config:", config);

    const { data } = await this.octokit.pulls.create({
      owner: config.repo.owner,
      repo: config.repo.repo,
      title: config.title,
      body: config.body,
      head: config.head,
      base: config.base,
      draft: config.draft || false,
    });

    return this.mapPullRequestResponse(data);
  }

  /**
   * Update an existing pull request
   */
  async updatePullRequest(
    config: PullRequestUpdateConfig,
  ): Promise<PullRequestInfo> {
    logger.debug("Updating PR with config:", config);

    const { data } = await this.octokit.pulls.update({
      owner: config.repo.owner,
      repo: config.repo.repo,
      pull_number: config.pullNumber,
      title: config.title,
      body: config.body,
    });

    return this.mapPullRequestResponse(data);
  }

  /**
   * Get a pull request by number
   */
  async getPullRequest(
    repo: GitHubRepo,
    pullNumber: number,
  ): Promise<PullRequestInfo> {
    const { data } = await this.octokit.pulls.get({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: pullNumber,
    });

    return this.mapPullRequestResponse(data);
  }

  /**
   * List open pull requests for a repo
   */
  async listPullRequests(
    repo: GitHubRepo,
    state: "open" | "closed" | "all" = "open",
  ): Promise<PullRequestInfo[]> {
    const { data } = await this.octokit.pulls.list({
      owner: repo.owner,
      repo: repo.repo,
      state,
      per_page: 30,
    });

    return data.map((pr) => this.mapPullRequestResponse(pr));
  }

  /**
   * Find PR for a specific branch
   */
  async findPRForBranch(
    repo: GitHubRepo,
    branchName: string,
  ): Promise<PullRequestInfo | null> {
    const { data } = await this.octokit.pulls.list({
      owner: repo.owner,
      repo: repo.repo,
      state: "open",
      head: `${repo.owner}:${branchName}`,
    });

    if (data.length === 0) return null;
    return this.mapPullRequestResponse(data[0]!);
  }

  /**
   * Get commits for a pull request
   */
  async getPRCommits(
    repo: GitHubRepo,
    pullNumber: number,
  ): Promise<CommitInfo[]> {
    const { data } = await this.octokit.pulls.listCommits({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    return data.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
      author: commit.commit.author?.name || commit.author?.login || "Unknown",
      date: commit.commit.author?.date || "",
    }));
  }

  /**
   * Get files changed in a PR
   */
  async getPRFiles(
    repo: GitHubRepo,
    pullNumber: number,
  ): Promise<
    Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
    }>
  > {
    const { data } = await this.octokit.pulls.listFiles({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    return data.map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    }));
  }

  /**
   * Verify token and connection
   */
  async verifyConnection(): Promise<{
    valid: boolean;
    username?: string;
    error?: string;
  }> {
    try {
      const username = await this.getAuthenticatedUser();
      return { valid: true, username };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // Helper to map GitHub API response to our type
  private mapPullRequestResponse(pr: {
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
    draft?: boolean;
    mergeable?: boolean | null;
    additions?: number;
    deletions?: number;
    changed_files?: number;
  }): PullRequestInfo {
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      html_url: pr.html_url,
      head: {
        ref: pr.head.ref,
        sha: pr.head.sha,
      },
      base: {
        ref: pr.base.ref,
      },
      user: pr.user,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      draft: pr.draft || false,
      mergeable: pr.mergeable ?? null,
      additions: pr.additions || 0,
      deletions: pr.deletions || 0,
      changed_files: pr.changed_files || 0,
    };
  }

  // ============================================
  // Repository Management
  // ============================================

  /**
   * Create a new repository
   */
  async createRepository(config: CreateRepoConfig): Promise<RepoInfo> {
    logger.debug("Creating repository with config:", config);

    const { data } = await this.octokit.repos.createForAuthenticatedUser({
      name: config.name,
      description: config.description,
      private: config.private ?? false,
      auto_init: config.auto_init ?? false,
      gitignore_template: config.gitignore_template,
      license_template: config.license_template,
    });

    return this.mapRepoResponse(data);
  }

  /**
   * Get repository info
   */
  async getRepoInfo(repo: GitHubRepo): Promise<RepoInfo> {
    const { data } = await this.octokit.repos.get({
      owner: repo.owner,
      repo: repo.repo,
    });

    return this.mapRepoResponse(data);
  }

  /**
   * Update repository settings (visibility, etc.)
   */
  async updateRepository(config: UpdateRepoConfig): Promise<RepoInfo> {
    logger.debug("Updating repository with config:", config);

    const { data } = await this.octokit.repos.update({
      owner: config.repo.owner,
      repo: config.repo.repo,
      name: config.name,
      description: config.description,
      private: config.private,
      has_issues: config.has_issues,
      has_wiki: config.has_wiki,
      has_projects: config.has_projects,
    });

    return this.mapRepoResponse(data);
  }

  /**
   * Get README content
   */
  async getReadme(
    repo: GitHubRepo,
  ): Promise<{ content: string; sha: string } | null> {
    try {
      const { data } = await this.octokit.repos.getReadme({
        owner: repo.owner,
        repo: repo.repo,
      });

      const content = Buffer.from(data.content, "base64").toString("utf-8");
      return { content, sha: data.sha };
    } catch (error) {
      logger.debug("No README found or error fetching:", error);
      return null;
    }
  }

  /**
   * Create or update README
   */
  async updateReadme(
    repo: GitHubRepo,
    content: string,
    message?: string,
  ): Promise<{ html_url: string }> {
    const existingReadme = await this.getReadme(repo);
    const commitMessage =
      message || (existingReadme ? "Update README.md" : "Create README.md");

    const { data } = await this.octokit.repos.createOrUpdateFileContents({
      owner: repo.owner,
      repo: repo.repo,
      path: "README.md",
      message: commitMessage,
      content: Buffer.from(content).toString("base64"),
      sha: existingReadme?.sha,
    });

    return {
      html_url:
        data.content?.html_url ||
        `https://github.com/${repo.owner}/${repo.repo}`,
    };
  }

  /**
   * Check if issues are enabled and get issue stats
   */
  async checkIssues(repo: GitHubRepo): Promise<{
    enabled: boolean;
    open_count: number;
    closed_count: number;
  }> {
    const repoInfo = await this.getRepoInfo(repo);

    if (!repoInfo.has_issues) {
      return { enabled: false, open_count: 0, closed_count: 0 };
    }

    // Get open issues count (already in repoInfo)
    const open_count = repoInfo.open_issues_count;

    // Get closed issues count
    try {
      const { data: closedIssues } = await this.octokit.issues.listForRepo({
        owner: repo.owner,
        repo: repo.repo,
        state: "closed",
        per_page: 1,
      });

      // Return what we found
      return {
        enabled: true,
        open_count,
        closed_count: closedIssues.length > 0 ? 1 : 0, // Simplified
      };
    } catch {
      return { enabled: true, open_count, closed_count: 0 };
    }
  }

  /**
   * List repositories for authenticated user
   */
  async listMyRepos(options?: {
    sort?: "created" | "updated" | "pushed" | "full_name";
    per_page?: number;
  }): Promise<RepoInfo[]> {
    const { data } = await this.octokit.repos.listForAuthenticatedUser({
      sort: options?.sort || "updated",
      per_page: options?.per_page || 30,
    });

    return data.map((repo) => this.mapRepoResponse(repo));
  }

  // Helper to map repo response
  private mapRepoResponse(repo: {
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
    created_at: string | null;
    updated_at: string | null;
    owner: { login: string };
  }): RepoInfo {
    return {
      name: repo.name,
      full_name: repo.full_name,
      description: repo.description,
      private: repo.private,
      html_url: repo.html_url,
      clone_url: repo.clone_url,
      ssh_url: repo.ssh_url,
      default_branch: repo.default_branch,
      has_issues: repo.has_issues,
      has_wiki: repo.has_wiki,
      has_projects: repo.has_projects,
      open_issues_count: repo.open_issues_count,
      stargazers_count: repo.stargazers_count,
      forks_count: repo.forks_count,
      created_at: repo.created_at || "",
      updated_at: repo.updated_at || "",
      owner: repo.owner,
    };
  }
}

// Singleton instance
let githubServiceInstance: GitHubService | null = null;

export function getGitHubService(token?: string): GitHubService {
  if (!githubServiceInstance || token) {
    githubServiceInstance = new GitHubService(token);
  }
  return githubServiceInstance;
}

export default GitHubService;
