/**
 * Git state detection — reads the local filesystem.
 * Pure functions, no plugin context needed.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import type { GitContext } from "./types.js";

/** Execute a git command and return trimmed stdout, or null on failure */
function execGit(command: string, cwd?: string): string | null {
  try {
    const result = execSync(`git ${command}`, {
      cwd: cwd ?? process.cwd(),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch {
    return null;
  }
}

/** Parse a GitHub remote URL to extract owner and repo */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch && sshMatch[1] && sshMatch[2]) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch && httpsMatch[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  return null;
}

/**
 * Walk up from startPath looking for a .git directory.
 * Cross-platform: terminates when `dirname(path) === path` (POSIX root is `/`,
 * Windows drive root is `C:\` — both are fixed points of `dirname`).
 */
function findGitRoot(startPath?: string): string | null {
  let currentPath = startPath ?? process.cwd();

  while (true) {
    if (existsSync(resolve(currentPath, ".git"))) {
      return currentPath;
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }

    currentPath = parentPath;
  }
}

/** Resolve the default branch (main/master) from remote HEAD or local refs */
function getDefaultBranch(cwd?: string): string {
  const remoteHead = execGit("symbolic-ref refs/remotes/origin/HEAD", cwd);
  if (remoteHead) {
    const match = remoteHead.match(/refs\/remotes\/origin\/(.+)/);
    if (match && match[1]) {
      return match[1];
    }
  }

  if (execGit("rev-parse --verify main", cwd)) return "main";
  if (execGit("rev-parse --verify master", cwd)) return "master";

  return "main";
}

/** Build the full git context for a working directory */
export function getGitContext(workingDir?: string): GitContext {
  const cwd = workingDir ?? process.cwd();
  const repoRoot = findGitRoot(cwd);

  if (!repoRoot) {
    return { isGitRepo: false };
  }

  const context: GitContext = {
    isGitRepo: true,
    repoRoot,
  };

  const branch = execGit("rev-parse --abbrev-ref HEAD", repoRoot);
  if (branch) {
    context.currentBranch = branch;
  }

  const remoteUrl = execGit("config --get remote.origin.url", repoRoot);
  if (remoteUrl) {
    context.remoteUrl = remoteUrl;

    const parsed = parseGitHubUrl(remoteUrl);
    if (parsed) {
      context.owner = parsed.owner;
      context.repo = parsed.repo;
      context.fullRepo = `${parsed.owner}/${parsed.repo}`;
    }
  }

  context.defaultBranch = getDefaultBranch(repoRoot);

  const status = execGit("status --porcelain", repoRoot);
  context.hasUncommittedChanges = !!status && status.length > 0;

  if (status) {
    context.changedFiles = status
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3));
  }

  if (context.currentBranch) {
    const unpushed = execGit(
      `log origin/${context.currentBranch}..HEAD --oneline`,
      repoRoot,
    );
    context.hasUnpushedCommits = !!unpushed && unpushed.length > 0;
  }

  const commits = execGit('log -5 --pretty=format:"%h|%s"', repoRoot);
  if (commits) {
    context.recentCommits = commits
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ...messageParts] = line.split("|");
        return { sha: sha ?? "", message: messageParts.join("|") };
      });
  }

  return context;
}

/** Human-readable summary of a git context */
export function getGitContextSummary(context: GitContext): string {
  if (!context.isGitRepo) {
    return "Not in a git repository";
  }

  const lines: string[] = [];

  if (context.fullRepo) {
    lines.push(`Repository: ${context.fullRepo}`);
  }
  if (context.currentBranch) {
    lines.push(`Branch: ${context.currentBranch}`);
  }
  if (context.defaultBranch) {
    lines.push(`Default branch: ${context.defaultBranch}`);
  }
  if (context.hasUncommittedChanges) {
    lines.push(
      `Uncommitted changes: ${context.changedFiles?.length ?? 0} files`,
    );
  }
  if (context.hasUnpushedCommits) {
    lines.push("Has unpushed commits");
  }
  if (context.recentCommits && context.recentCommits.length > 0) {
    lines.push("Recent commits:");
    context.recentCommits.slice(0, 3).forEach((c) => {
      lines.push(`  ${c.sha} - ${c.message}`);
    });
  }

  return lines.join("\n");
}
