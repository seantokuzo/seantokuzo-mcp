/**
 * Git context types — owned by the git-context plugin.
 */

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
