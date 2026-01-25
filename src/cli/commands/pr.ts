/**
 * 🔀 PR Commands
 * Create, update, list, and manage pull requests
 */

import inquirer from "inquirer";
import chalk from "chalk";
import { getGitHubService } from "../../services/github.js";
import { getConfig } from "../../utils/config.js";
import {
  showBanner,
  showSuccess,
  showError,
  showWarning,
  showInfo,
  displayPRInfo,
  displayPRList,
  createStyledSpinner,
  showBox,
} from "../ui/display.js";
import type { GitHubRepo } from "../../types/index.js";

/**
 * Interactive PR creation flow
 */
export async function createPRInteractive(): Promise<void> {
  showBanner();

  const config = getConfig();

  try {
    const github = getGitHubService();

    // Verify connection first
    const spinner = createStyledSpinner("Connecting to GitHub");
    spinner.start();

    const connection = await github.verifyConnection();
    if (!connection.valid) {
      spinner.error({ text: "Failed to connect to GitHub" });
      showError("GitHub authentication failed", connection.error);
      return;
    }
    spinner.success({
      text: `Connected as ${chalk.cyan(connection.username)}`,
    });

    // Get repository
    const { repoInput } = await inquirer.prompt<{ repoInput: string }>([
      {
        type: "input",
        name: "repoInput",
        message: "📦 Repository (owner/repo or URL):",
        validate: (input: string) =>
          input.length > 0 || "Repository is required",
      },
    ]);

    let repo: GitHubRepo;
    try {
      repo = github.parseRepoIdentifier(repoInput);
    } catch (error) {
      showError("Invalid repository format", "Use owner/repo or a GitHub URL");
      return;
    }

    // Fetch branches
    const branchSpinner = createStyledSpinner("Fetching branches");
    branchSpinner.start();

    const branches = await github.listBranches(repo);
    branchSpinner.success({ text: `Found ${branches.length} branches` });

    const branchNames = branches.map((b) => b.name);

    // Get branch info
    const { sourceBranch, targetBranch } = await inquirer.prompt<{
      sourceBranch: string;
      targetBranch: string;
    }>([
      {
        type: "list",
        name: "sourceBranch",
        message: "🌿 Source branch (your changes):",
        choices: branchNames,
        default: branchNames.find((b) => b !== "main" && b !== "master"),
      },
      {
        type: "list",
        name: "targetBranch",
        message: "🎯 Target branch (merge into):",
        choices: branchNames,
        default: config.defaults.baseBranch,
      },
    ]);

    // Check for existing PR
    const existingPR = await github.findPRForBranch(repo, sourceBranch);
    if (existingPR) {
      showWarning(`A PR already exists for branch ${sourceBranch}`);
      displayPRInfo(existingPR);

      const { updateExisting } = await inquirer.prompt<{
        updateExisting: boolean;
      }>([
        {
          type: "confirm",
          name: "updateExisting",
          message: "Would you like to update the existing PR instead?",
          default: true,
        },
      ]);

      if (updateExisting) {
        await updatePRInteractive(repo, existingPR.number);
        return;
      }
      return;
    }

    // Get commit info for context
    const commitSpinner = createStyledSpinner("Analyzing commits");
    commitSpinner.start();

    const commits = await github.getCommitsBetween(
      repo,
      targetBranch,
      sourceBranch,
    );
    const diffStats = await github.getDiffStats(
      repo,
      targetBranch,
      sourceBranch,
    );
    commitSpinner.success({
      text: `Found ${commits.length} commits, ${diffStats.changedFiles} files changed`,
    });

    // Show commit summary
    if (commits.length > 0) {
      console.log();
      console.log(chalk.bold("  📝 Commits to be included:"));
      commits.slice(0, 5).forEach((commit) => {
        const shortSha = commit.sha.slice(0, 7);
        const message = commit.message.split("\n")[0]?.slice(0, 60) || "";
        console.log(chalk.gray(`     ${shortSha} - ${message}`));
      });
      if (commits.length > 5) {
        console.log(chalk.gray(`     ... and ${commits.length - 5} more`));
      }
      console.log();
    }

    // Get PR details
    const defaultTitle =
      commits[0]?.message.split("\n")[0] ||
      `Merge ${sourceBranch} into ${targetBranch}`;

    const { title, userContext, isDraft } = await inquirer.prompt<{
      title: string;
      userContext: string;
      isDraft: boolean;
    }>([
      {
        type: "input",
        name: "title",
        message: "📌 PR Title:",
        default: defaultTitle,
        validate: (input: string) => input.length > 0 || "Title is required",
      },
      {
        type: "editor",
        name: "userContext",
        message:
          "📝 Describe your changes (optional - helps generate better description):",
        default: "",
      },
      {
        type: "confirm",
        name: "isDraft",
        message: "📝 Create as draft PR?",
        default: config.defaults.draft,
      },
    ]);

    // Generate PR description
    const body = generatePRDescription({
      title,
      commits,
      diffStats,
      userContext,
      sourceBranch,
      targetBranch,
    });

    // Show preview
    showBox(body, { title: "📄 PR Description Preview", borderColor: "cyan" });

    const { confirmCreate } = await inquirer.prompt<{ confirmCreate: boolean }>(
      [
        {
          type: "confirm",
          name: "confirmCreate",
          message: "🚀 Create this PR?",
          default: true,
        },
      ],
    );

    if (!confirmCreate) {
      showInfo("PR creation cancelled.");
      return;
    }

    // Create the PR!
    const createSpinner = createStyledSpinner("Creating PR");
    createSpinner.start();

    const pr = await github.createPullRequest({
      repo,
      title,
      body,
      head: sourceBranch,
      base: targetBranch,
      draft: isDraft,
    });

    createSpinner.success({ text: "PR created!" });

    showSuccess(`PR #${pr.number} created successfully!`);
    displayPRInfo(pr);
  } catch (error) {
    showError(
      "Failed to create PR",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

/**
 * Interactive PR update flow
 */
export async function updatePRInteractive(
  existingRepo?: GitHubRepo,
  existingPRNumber?: number,
): Promise<void> {
  if (!existingRepo) {
    showBanner();
  }

  try {
    const github = getGitHubService();

    let repo = existingRepo;
    let prNumber = existingPRNumber;

    if (!repo) {
      // Verify connection first
      const spinner = createStyledSpinner("Connecting to GitHub");
      spinner.start();

      const connection = await github.verifyConnection();
      if (!connection.valid) {
        spinner.error({ text: "Failed to connect to GitHub" });
        showError("GitHub authentication failed", connection.error);
        return;
      }
      spinner.success({
        text: `Connected as ${chalk.cyan(connection.username)}`,
      });

      // Get repository
      const { repoInput } = await inquirer.prompt<{ repoInput: string }>([
        {
          type: "input",
          name: "repoInput",
          message: "📦 Repository (owner/repo or URL):",
          validate: (input: string) =>
            input.length > 0 || "Repository is required",
        },
      ]);

      repo = github.parseRepoIdentifier(repoInput);
    }

    if (!prNumber) {
      // List open PRs
      const prSpinner = createStyledSpinner("Fetching open PRs");
      prSpinner.start();

      const openPRs = await github.listPullRequests(repo, "open");
      prSpinner.success({ text: `Found ${openPRs.length} open PRs` });

      if (openPRs.length === 0) {
        showInfo("No open PRs found for this repository.");
        return;
      }

      // Select PR
      const { selectedPR } = await inquirer.prompt<{ selectedPR: number }>([
        {
          type: "list",
          name: "selectedPR",
          message: "🔀 Select PR to update:",
          choices: openPRs.map((pr) => ({
            name: `#${pr.number} - ${pr.title} (${pr.head.ref})`,
            value: pr.number,
          })),
        },
      ]);

      prNumber = selectedPR;
    }

    // Get current PR info
    const pr = await github.getPullRequest(repo, prNumber);

    console.log();
    console.log(chalk.bold("  📋 Current PR:"));
    displayPRInfo(pr);

    // Get what to update
    const { updateTitle, updateBody } = await inquirer.prompt<{
      updateTitle: boolean;
      updateBody: boolean;
    }>([
      {
        type: "confirm",
        name: "updateTitle",
        message: "📌 Update title?",
        default: false,
      },
      {
        type: "confirm",
        name: "updateBody",
        message: "📝 Update description?",
        default: true,
      },
    ]);

    let newTitle = pr.title;
    let newBody = pr.body || "";

    if (updateTitle) {
      const { title } = await inquirer.prompt<{ title: string }>([
        {
          type: "input",
          name: "title",
          message: "📌 New title:",
          default: pr.title,
        },
      ]);
      newTitle = title;
    }

    if (updateBody) {
      // Get commits for context
      const commits = await github.getPRCommits(repo, prNumber);

      const { userContext } = await inquirer.prompt<{ userContext: string }>([
        {
          type: "editor",
          name: "userContext",
          message: "📝 Additional context for the description (opens editor):",
          default: "",
        },
      ]);

      newBody = generatePRDescription({
        title: newTitle,
        commits,
        diffStats: {
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changed_files,
        },
        userContext,
        sourceBranch: pr.head.ref,
        targetBranch: pr.base.ref,
        existingBody: pr.body || undefined,
      });

      showBox(newBody, {
        title: "📄 Updated Description Preview",
        borderColor: "cyan",
      });
    }

    const { confirmUpdate } = await inquirer.prompt<{ confirmUpdate: boolean }>(
      [
        {
          type: "confirm",
          name: "confirmUpdate",
          message: "✏️ Apply these changes?",
          default: true,
        },
      ],
    );

    if (!confirmUpdate) {
      showInfo("Update cancelled.");
      return;
    }

    // Update the PR
    const updateSpinner = createStyledSpinner("Updating PR");
    updateSpinner.start();

    const updatedPR = await github.updatePullRequest({
      repo,
      pullNumber: prNumber,
      title: updateTitle ? newTitle : undefined,
      body: updateBody ? newBody : undefined,
    });

    updateSpinner.success({ text: "PR updated!" });

    showSuccess(`PR #${updatedPR.number} updated successfully!`);
    displayPRInfo(updatedPR);
  } catch (error) {
    showError(
      "Failed to update PR",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

/**
 * List PRs for a repository
 */
export async function listPRsInteractive(): Promise<void> {
  showBanner();

  try {
    const github = getGitHubService();

    // Verify connection
    const spinner = createStyledSpinner("Connecting to GitHub");
    spinner.start();

    const connection = await github.verifyConnection();
    if (!connection.valid) {
      spinner.error({ text: "Failed to connect to GitHub" });
      showError("GitHub authentication failed", connection.error);
      return;
    }
    spinner.success({
      text: `Connected as ${chalk.cyan(connection.username)}`,
    });

    // Get repository
    const { repoInput } = await inquirer.prompt<{ repoInput: string }>([
      {
        type: "input",
        name: "repoInput",
        message: "📦 Repository (owner/repo or URL):",
        validate: (input: string) =>
          input.length > 0 || "Repository is required",
      },
    ]);

    const repo = github.parseRepoIdentifier(repoInput);

    const { state } = await inquirer.prompt<{
      state: "open" | "closed" | "all";
    }>([
      {
        type: "list",
        name: "state",
        message: "📊 PR state:",
        choices: [
          { name: "🟢 Open", value: "open" },
          { name: "🔴 Closed", value: "closed" },
          { name: "📋 All", value: "all" },
        ],
        default: "open",
      },
    ]);

    // Fetch PRs
    const prSpinner = createStyledSpinner("Fetching PRs");
    prSpinner.start();

    const prs = await github.listPullRequests(repo, state);
    prSpinner.success({ text: `Found ${prs.length} PRs` });

    displayPRList(prs);

    if (prs.length > 0) {
      const { viewDetails } = await inquirer.prompt<{ viewDetails: boolean }>([
        {
          type: "confirm",
          name: "viewDetails",
          message: "View details of a specific PR?",
          default: false,
        },
      ]);

      if (viewDetails) {
        const { selectedPR } = await inquirer.prompt<{ selectedPR: number }>([
          {
            type: "list",
            name: "selectedPR",
            message: "Select PR:",
            choices: prs.map((pr) => ({
              name: `#${pr.number} - ${pr.title}`,
              value: pr.number,
            })),
          },
        ]);

        const prDetails = await github.getPullRequest(repo, selectedPR);
        displayPRInfo(prDetails);
      }
    }
  } catch (error) {
    showError(
      "Failed to list PRs",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

/**
 * Generate a PR description from context
 */
function generatePRDescription(context: {
  title: string;
  commits: Array<{ message: string; sha: string; author: string }>;
  diffStats: { additions: number; deletions: number; changedFiles: number };
  userContext?: string;
  sourceBranch: string;
  targetBranch: string;
  existingBody?: string;
}): string {
  const { commits, diffStats, userContext, sourceBranch, targetBranch } =
    context;

  const sections: string[] = [];

  // Description section
  sections.push("## 📋 Description");
  if (userContext && userContext.trim()) {
    sections.push(userContext.trim());
  } else {
    sections.push(
      `This PR merges \`${sourceBranch}\` into \`${targetBranch}\`.`,
    );
  }

  // Changes summary
  sections.push("");
  sections.push("## 📊 Changes");
  sections.push(`- **Files changed:** ${diffStats.changedFiles}`);
  sections.push(`- **Additions:** +${diffStats.additions}`);
  sections.push(`- **Deletions:** -${diffStats.deletions}`);

  // Commits section
  if (commits.length > 0) {
    sections.push("");
    sections.push("## 📝 Commits");
    commits.slice(0, 10).forEach((commit) => {
      const message = commit.message.split("\n")[0] || "";
      sections.push(`- \`${commit.sha.slice(0, 7)}\` ${message}`);
    });
    if (commits.length > 10) {
      sections.push(`- ... and ${commits.length - 10} more commits`);
    }
  }

  // Checklist
  sections.push("");
  sections.push("## ✅ Checklist");
  sections.push("- [ ] Code has been tested");
  sections.push("- [ ] Documentation updated (if needed)");
  sections.push("- [ ] No breaking changes (or documented if any)");

  // Footer
  sections.push("");
  sections.push("---");
  sections.push(
    "*Generated by [Sean-MCP](https://github.com/seantokuzo/seantokuzo-mcp) 🚀*",
  );

  return sections.join("\n");
}

export default {
  createPRInteractive,
  updatePRInteractive,
  listPRsInteractive,
};
