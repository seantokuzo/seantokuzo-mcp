/**
 * 🔍 Git Context Service
 * Detects current repo, branch, and git state from the local filesystem
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve, dirname } from "path";

export interface GitContext {
  /** Whether we're in a git repository */
  isGitRepo: boolean;
  /** Repository root path */
  repoRoot?: string;
  /** Current branch name */
  currentBranch?: string;
  /** Remote origin URL */
  remoteUrl?: string;
  /** Parsed owner from remote URL */
  owner?: string;
  /** Parsed repo name from remote URL */
  repo?: string;
  /** Owner/repo format */
  fullRepo?: string;
  /** Default branch (main/master) */
  defaultBranch?: string;
  /** Whether there are uncommitted changes */
  hasUncommittedChanges?: boolean;
  /** Whether there are unpushed commits */
  hasUnpushedCommits?: boolean;
  /** List of changed files */
  changedFiles?: string[];
  /** Recent commits on current branch */
  recentCommits?: Array<{ sha: string; message: string }>;
}

/**
 * Execute a git command and return the output
 */
function execGit(command: string, cwd?: string): string | null {
  try {
    const result = execSync(`git ${command}`, {
      cwd: cwd || process.cwd(),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Parse a GitHub remote URL to extract owner and repo
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  // Handle SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch && sshMatch[1] && sshMatch[2]) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // Handle HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch && httpsMatch[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  return null;
}

/**
 * Find the git repository root from a given path
 */
function findGitRoot(startPath?: string): string | null {
  let currentPath = startPath || process.cwd();

  // Walk up the directory tree looking for .git
  while (currentPath !== "/") {
    if (existsSync(resolve(currentPath, ".git"))) {
      return currentPath;
    }
    currentPath = dirname(currentPath);
  }

  return null;
}

/**
 * Get the default branch (main or master)
 */
function getDefaultBranch(cwd?: string): string {
  // Try to get from remote HEAD
  const remoteHead = execGit("symbolic-ref refs/remotes/origin/HEAD", cwd);
  if (remoteHead) {
    const match = remoteHead.match(/refs\/remotes\/origin\/(.+)/);
    if (match && match[1]) {
      return match[1];
    }
  }

  // Check if main exists
  const mainExists = execGit("rev-parse --verify main", cwd);
  if (mainExists) return "main";

  // Fall back to master
  const masterExists = execGit("rev-parse --verify master", cwd);
  if (masterExists) return "master";

  return "main"; // Default assumption
}

/**
 * Get the full git context for the current directory
 */
export function getGitContext(workingDir?: string): GitContext {
  const cwd = workingDir || process.cwd();
  const repoRoot = findGitRoot(cwd);

  if (!repoRoot) {
    return { isGitRepo: false };
  }

  const context: GitContext = {
    isGitRepo: true,
    repoRoot,
  };

  // Get current branch
  const branch = execGit("rev-parse --abbrev-ref HEAD", repoRoot);
  if (branch) {
    context.currentBranch = branch;
  }

  // Get remote URL
  const remoteUrl = execGit("config --get remote.origin.url", repoRoot);
  if (remoteUrl) {
    context.remoteUrl = remoteUrl;

    // Parse GitHub URL
    const parsed = parseGitHubUrl(remoteUrl);
    if (parsed) {
      context.owner = parsed.owner;
      context.repo = parsed.repo;
      context.fullRepo = `${parsed.owner}/${parsed.repo}`;
    }
  }

  // Get default branch
  context.defaultBranch = getDefaultBranch(repoRoot);

  // Check for uncommitted changes
  const status = execGit("status --porcelain", repoRoot);
  context.hasUncommittedChanges = !!status && status.length > 0;

  if (status) {
    context.changedFiles = status
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3));
  }

  // Check for unpushed commits
  if (context.currentBranch) {
    const unpushed = execGit(
      `log origin/${context.currentBranch}..HEAD --oneline`,
      repoRoot,
    );
    context.hasUnpushedCommits = !!unpushed && unpushed.length > 0;
  }

  // Get recent commits (last 5)
  const commits = execGit('log -5 --pretty=format:"%h|%s"', repoRoot);
  if (commits) {
    context.recentCommits = commits
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ...messageParts] = line.split("|");
        return { sha: sha || "", message: messageParts.join("|") };
      });
  }

  return context;
}

/**
 * Get a human-readable summary of the git context
 */
export function getGitContextSummary(context: GitContext): string {
  if (!context.isGitRepo) {
    return "Not in a git repository";
  }

  const lines: string[] = [];

  if (context.fullRepo) {
    lines.push(`📦 Repository: ${context.fullRepo}`);
  }

  if (context.currentBranch) {
    lines.push(`🌿 Branch: ${context.currentBranch}`);
  }

  if (context.defaultBranch) {
    lines.push(`🎯 Default branch: ${context.defaultBranch}`);
  }

  if (context.hasUncommittedChanges) {
    lines.push(
      `⚠️  Uncommitted changes: ${context.changedFiles?.length || 0} files`,
    );
  }

  if (context.hasUnpushedCommits) {
    lines.push(`📤 Has unpushed commits`);
  }

  if (context.recentCommits && context.recentCommits.length > 0) {
    lines.push(`\n📝 Recent commits:`);
    context.recentCommits.slice(0, 3).forEach((c) => {
      lines.push(`   ${c.sha} - ${c.message}`);
    });
  }

  return lines.join("\n");
}

/**
 * Check if the current branch has a remote tracking branch
 */
export function hasRemoteBranch(branch: string, cwd?: string): boolean {
  const result = execGit(`ls-remote --heads origin ${branch}`, cwd);
  return !!result && result.length > 0;
}

/**
 * Get list of local branches
 */
export function getLocalBranches(cwd?: string): string[] {
  const result = execGit("branch --format='%(refname:short)'", cwd);
  if (!result) return [];
  return result
    .split("\n")
    .filter(Boolean)
    .map((b) => b.replace(/'/g, ""));
}

/**
 * Get list of remote branches
 */
export function getRemoteBranches(cwd?: string): string[] {
  const result = execGit("branch -r --format='%(refname:short)'", cwd);
  if (!result) return [];
  return result
    .split("\n")
    .filter(Boolean)
    .map((b) => b.replace(/'/g, "").replace("origin/", ""))
    .filter((b) => b !== "HEAD");
}

export default {
  getGitContext,
  getGitContextSummary,
  hasRemoteBranch,
  getLocalBranches,
  getRemoteBranches,
};
