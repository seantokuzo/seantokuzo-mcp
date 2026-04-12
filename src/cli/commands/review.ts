/**
 * 🔍 Review Commands
 * Open PRs, review changes, submit reviews
 */

import inquirer from "inquirer";
import chalk from "chalk";
import { GitHubClient } from "../../plugins/github/client.js";
import {
  showBanner,
  showSuccess,
  showError,
  showInfo,
  showBox,
  createStyledSpinner,
} from "../ui/display.js";
import type {
  GitHubRepo,
  PRFileDiff,
  PullRequestInfo,
} from "../../plugins/github/types.js";

// CLI-only type — inlined from legacy src/types/index.ts
interface CodeConcern {
  file: string;
  line: number;
  severity: "low" | "medium" | "high" | "critical";
  type: "security" | "performance" | "bug" | "style" | "complexity" | "other";
  message: string;
  suggestion?: string;
}

/**
 * Find a PR by branch name within an org/repo.
 * Inlined from legacy GitHubService.findPRByBranchInOrg — not available on GitHubClient.
 *
 * Errors propagate to the caller so auth/rate-limit/permission failures surface
 * with a real message instead of silently becoming "No PR found".
 */
async function findPRByBranchInOrg(
  github: GitHubClient,
  org: string,
  repoName: string,
  branchName: string,
): Promise<PullRequestInfo | null> {
  const repo: GitHubRepo = { owner: org, repo: repoName };

  // First try with head filter
  const pr = await github.findPRForBranch(repo, branchName);
  if (pr) return pr;

  // Fallback: list open PRs and match head ref case-insensitively
  const prs = await github.listPullRequests(repo, "open");
  const found = prs.find(
    (p) => p.head.ref.toLowerCase() === branchName.toLowerCase(),
  );
  return found ?? null;
}

/**
 * Open a PR for review - find by repo name and branch
 */
export async function openPRInteractive(): Promise<void> {
  showBanner();

  try {
    const github = new GitHubClient({
      token: process.env["GITHUB_TOKEN"] ?? "",
      username: process.env["GITHUB_USERNAME"],
    });

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

    // Get repo name (short name like "platform")
    const { repoName, branchName } = await inquirer.prompt<{
      repoName: string;
      branchName: string;
    }>([
      {
        type: "input",
        name: "repoName",
        message: "📦 Repository name (e.g., platform):",
        validate: (input: string) =>
          input.length > 0 || "Repository name is required",
      },
      {
        type: "input",
        name: "branchName",
        message: "🌿 Branch name:",
        validate: (input: string) =>
          input.length > 0 || "Branch name is required",
      },
    ]);

    // Get org from env or ask
    let org = process.env["GITHUB_ORG"] ?? "";
    if (!org) {
      const { orgInput } = await inquirer.prompt<{ orgInput: string }>([
        {
          type: "input",
          name: "orgInput",
          message: "🏢 GitHub Organization:",
          validate: (input: string) =>
            input.length > 0 || "Organization is required",
        },
      ]);
      org = orgInput;
    }

    // Find the PR
    const prSpinner = createStyledSpinner(
      `Searching for PR in ${org}/${repoName}`,
    );
    prSpinner.start();

    const pr = await findPRByBranchInOrg(github, org, repoName, branchName);

    if (!pr) {
      prSpinner.error({ text: "No PR found" });
      showError(
        `No open PR found for branch "${branchName}" in ${org}/${repoName}`,
        "Make sure the branch exists and has an open PR.",
      );
      return;
    }

    prSpinner.success({ text: `Found PR #${pr.number}` });

    // Display PR info
    displayPRDetails(pr);

    // Ask what to do
    const { action } = await inquirer.prompt<{ action: string }>([
      {
        type: "list",
        name: "action",
        message: "What would you like to do?",
        choices: [
          { name: "📂 View changed files", value: "files" },
          { name: "🔍 Review with analysis", value: "review" },
          { name: "✅ Quick approve", value: "approve" },
          { name: "💬 Add comment only", value: "comment" },
          { name: "🌐 Open in browser", value: "browser" },
          { name: "👋 Exit", value: "exit" },
        ],
      },
    ]);

    const repo: GitHubRepo = { owner: org, repo: repoName };

    switch (action) {
      case "files":
        await showChangedFiles(github, repo, pr.number);
        break;
      case "review":
        await reviewPRWithAnalysis(github, repo, pr);
        break;
      case "approve":
        await quickApprove(github, repo, pr.number);
        break;
      case "comment":
        await addCommentOnly(github, repo, pr.number);
        break;
      case "browser":
        console.log(chalk.cyan(`\n  🌐 ${pr.html_url}\n`));
        break;
    }
  } catch (error) {
    showError(
      "Failed to open PR",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Show changed files in a PR
 */
async function showChangedFiles(
  github: GitHubClient,
  repo: GitHubRepo,
  pullNumber: number,
): Promise<void> {
  const spinner = createStyledSpinner("Fetching changed files");
  spinner.start();

  const files = await github.getPRFilesWithPatch(repo, pullNumber);
  spinner.success({ text: `Found ${files.length} changed files` });

  console.log();
  console.log(chalk.bold.cyan("  📂 Changed Files"));
  console.log(chalk.gray("  ─────────────────────────────────────────"));

  files.forEach((file) => {
    const statusIcon = getStatusIcon(file.status);
    const stats = `${chalk.green(`+${file.additions}`)} ${chalk.red(`-${file.deletions}`)}`;
    console.log(`  ${statusIcon} ${chalk.white(file.filename)} ${stats}`);
  });

  console.log(chalk.gray("  ─────────────────────────────────────────"));
  console.log();

  // Offer to view specific file
  const { viewFile } = await inquirer.prompt<{ viewFile: boolean }>([
    {
      type: "confirm",
      name: "viewFile",
      message: "View a specific file's diff?",
      default: false,
    },
  ]);

  if (viewFile) {
    const { selectedFile } = await inquirer.prompt<{ selectedFile: string }>([
      {
        type: "list",
        name: "selectedFile",
        message: "Select file:",
        choices: files.map((f) => ({
          name: `${getStatusIcon(f.status)} ${f.filename}`,
          value: f.filename,
        })),
      },
    ]);

    const file = files.find((f) => f.filename === selectedFile);
    if (file && file.patch) {
      showFileDiff(file);
    } else {
      showInfo(
        "No diff available for this file (might be binary or too large)",
      );
    }
  }
}

/**
 * Review PR with analysis - identify concerns
 */
async function reviewPRWithAnalysis(
  github: GitHubClient,
  repo: GitHubRepo,
  pr: PullRequestInfo,
): Promise<void> {
  const spinner = createStyledSpinner("Analyzing PR changes");
  spinner.start();

  const files = await github.getPRFilesWithPatch(repo, pr.number);
  const commits = await github.getPRCommits(repo, pr.number);
  const existingReviews = await github.getPRReviews(repo, pr.number);

  spinner.success({ text: "Analysis complete" });

  // Show summary
  console.log();
  showBox(
    [
      `${chalk.bold("Files changed:")} ${files.length}`,
      `${chalk.bold("Commits:")} ${commits.length}`,
      `${chalk.bold("Existing reviews:")} ${existingReviews.length}`,
      "",
      `${chalk.bold("Total changes:")} ${chalk.green(`+${pr.additions}`)} ${chalk.red(`-${pr.deletions}`)}`,
    ].join("\n"),
    { title: "📊 PR Summary", borderColor: "cyan" },
  );

  // Analyze files for concerns
  const concerns = analyzeFilesForConcerns(files);

  if (concerns.length > 0) {
    console.log();
    console.log(chalk.bold.yellow("  ⚠️  Areas of Concern"));
    console.log(chalk.gray("  ─────────────────────────────────────────"));

    concerns.forEach((concern) => {
      const severityColor = getSeverityColor(concern.severity);
      const icon = getSeverityIcon(concern.severity);
      console.log(
        `  ${icon} ${severityColor(concern.severity.toUpperCase())} - ${chalk.white(concern.file)}`,
      );
      console.log(
        `     ${chalk.gray("Line " + concern.line)}: ${concern.message}`,
      );
      if (concern.suggestion) {
        console.log(`     ${chalk.cyan("💡 " + concern.suggestion)}`);
      }
      console.log();
    });
  } else {
    showInfo("No obvious concerns detected. Still review manually!");
  }

  // Show files grouped by type
  console.log();
  console.log(chalk.bold.cyan("  📁 Files by Type"));
  const filesByExtension = groupFilesByExtension(files);
  Object.entries(filesByExtension).forEach(([ext, fileList]) => {
    console.log(
      `  ${chalk.yellow(ext || "no extension")}: ${fileList.length} files`,
    );
  });
  console.log();

  // Review each file interactively?
  const { reviewStyle } = await inquirer.prompt<{ reviewStyle: string }>([
    {
      type: "list",
      name: "reviewStyle",
      message: "How would you like to proceed?",
      choices: [
        { name: "📋 Review files one by one", value: "sequential" },
        { name: "⚠️  Jump to concerns only", value: "concerns" },
        { name: "✅ Submit approval now", value: "approve" },
        { name: "💬 Submit comment without approval", value: "comment" },
        { name: "❌ Request changes", value: "changes" },
      ],
    },
  ]);

  switch (reviewStyle) {
    case "sequential":
      await reviewFilesSequentially(github, repo, pr.number, files);
      break;
    case "concerns":
      await reviewConcernsOnly(github, repo, pr.number, files, concerns);
      break;
    case "approve":
      await submitReviewInteractive(github, repo, pr.number, "APPROVE");
      break;
    case "comment":
      await submitReviewInteractive(github, repo, pr.number, "COMMENT");
      break;
    case "changes":
      await submitReviewInteractive(github, repo, pr.number, "REQUEST_CHANGES");
      break;
  }
}

/**
 * Review files one by one
 */
async function reviewFilesSequentially(
  github: GitHubClient,
  repo: GitHubRepo,
  pullNumber: number,
  files: PRFileDiff[],
): Promise<void> {
  for (const file of files) {
    console.log();
    console.log(chalk.bold(`\n📄 ${file.filename}`));
    console.log(chalk.gray("─".repeat(50)));

    if (file.patch) {
      showFileDiff(file);
    } else {
      console.log(chalk.gray("  (No diff available - binary or too large)"));
    }

    const { action } = await inquirer.prompt<{ action: string }>([
      {
        type: "list",
        name: "action",
        message: "Action for this file:",
        choices: [
          { name: "➡️  Next file", value: "next" },
          { name: "💬 Add comment on this file", value: "comment" },
          { name: "✅ Done reviewing, submit", value: "done" },
          { name: "❌ Stop review", value: "stop" },
        ],
      },
    ]);

    if (action === "comment") {
      // Would add inline comment - simplified for CLI
      const { comment } = await inquirer.prompt<{ comment: string }>([
        {
          type: "input",
          name: "comment",
          message: "Comment:",
        },
      ]);
      console.log(chalk.green(`  ✓ Comment noted: "${comment}"`));
    } else if (action === "done") {
      await submitReviewInteractive(github, repo, pullNumber, "COMMENT");
      break;
    } else if (action === "stop") {
      break;
    }
  }
}

/**
 * Review only files with concerns
 */
async function reviewConcernsOnly(
  github: GitHubClient,
  repo: GitHubRepo,
  pullNumber: number,
  files: PRFileDiff[],
  concerns: CodeConcern[],
): Promise<void> {
  const filesWithConcerns = new Set(concerns.map((c) => c.file));
  const relevantFiles = files.filter((f) => filesWithConcerns.has(f.filename));

  if (relevantFiles.length === 0) {
    showInfo("No files with concerns to review!");
    return;
  }

  for (const file of relevantFiles) {
    const fileConcerns = concerns.filter((c) => c.file === file.filename);

    console.log();
    console.log(
      chalk.bold(`\n⚠️  ${file.filename} (${fileConcerns.length} concerns)`),
    );
    console.log(chalk.gray("─".repeat(50)));

    fileConcerns.forEach((concern) => {
      const severityColor = getSeverityColor(concern.severity);
      console.log(`  Line ${concern.line}: ${severityColor(concern.message)}`);
    });

    if (file.patch) {
      showFileDiff(file);
    }

    const { action } = await inquirer.prompt<{ action: string }>([
      {
        type: "list",
        name: "action",
        message: "Action:",
        choices: [
          { name: "➡️  Next concern file", value: "next" },
          { name: "✅ Done, submit review", value: "done" },
        ],
      },
    ]);

    if (action === "done") {
      break;
    }
  }

  await submitReviewInteractive(github, repo, pullNumber, "COMMENT");
}

/**
 * Quick approve a PR
 */
async function quickApprove(
  github: GitHubClient,
  repo: GitHubRepo,
  pullNumber: number,
): Promise<void> {
  const { comment } = await inquirer.prompt<{ comment: string }>([
    {
      type: "input",
      name: "comment",
      message: "Approval comment (optional):",
      default: "LGTM! 🚀",
    },
  ]);

  await submitReviewInteractive(github, repo, pullNumber, "APPROVE", comment);
}

/**
 * Add a comment without approving
 */
async function addCommentOnly(
  github: GitHubClient,
  repo: GitHubRepo,
  pullNumber: number,
): Promise<void> {
  const { comment } = await inquirer.prompt<{ comment: string }>([
    {
      type: "input",
      name: "comment",
      message: "Comment:",
      validate: (input: string) => input.length > 0 || "Comment is required",
    },
  ]);

  await submitReviewInteractive(github, repo, pullNumber, "COMMENT", comment);
}

/**
 * Submit a review
 */
export async function submitReviewInteractive(
  github: GitHubClient,
  repo: GitHubRepo,
  pullNumber: number,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  body?: string,
): Promise<void> {
  if (!body) {
    const { reviewBody } = await inquirer.prompt<{ reviewBody: string }>([
      {
        type: "input",
        name: "reviewBody",
        message: `Review comment for ${event}:`,
        default: event === "APPROVE" ? "Looks good! ✅" : undefined,
      },
    ]);
    body = reviewBody;
  }

  const spinner = createStyledSpinner("Submitting review");
  spinner.start();

  try {
    await github.submitReview({
      repo,
      pullNumber,
      body: body || "",
      event,
    });

    spinner.success({ text: "Review submitted!" });

    const messages: Record<string, string> = {
      APPROVE: "PR approved! 🎉",
      REQUEST_CHANGES: "Changes requested",
      COMMENT: "Comment added",
    };

    showSuccess(messages[event] || "Review submitted!");
  } catch (error) {
    spinner.error({ text: "Failed to submit review" });
    showError(
      "Failed to submit review",
      error instanceof Error ? error.message : String(error),
    );
  }
}

// ============================================
// Helper Functions
// ============================================

function displayPRDetails(pr: PullRequestInfo): void {
  const statusColor = pr.draft ? chalk.gray : chalk.green;
  const statusText = pr.draft ? "DRAFT" : pr.state.toUpperCase();

  const content = [
    `${chalk.bold("Title:")} ${pr.title}`,
    `${chalk.bold("Number:")} #${pr.number}`,
    `${chalk.bold("Status:")} ${statusColor(statusText)}`,
    `${chalk.bold("Branch:")} ${chalk.cyan(pr.head.ref)} → ${chalk.cyan(pr.base.ref)}`,
    `${chalk.bold("Author:")} ${pr.user?.login || "Unknown"}`,
    "",
    `${chalk.bold("Changes:")} ${chalk.green(`+${pr.additions}`)} ${chalk.red(`-${pr.deletions}`)} in ${pr.changed_files} files`,
    "",
    `${chalk.bold("URL:")} ${chalk.underline.blue(pr.html_url)}`,
  ].join("\n");

  showBox(content, {
    title: "🔀 Pull Request",
    borderColor: pr.draft ? "gray" : "green",
  });
}

function getStatusIcon(status: string): string {
  const icons: Record<string, string> = {
    added: "🟢",
    removed: "🔴",
    modified: "🟡",
    renamed: "🔄",
    copied: "📋",
  };
  return icons[status] || "⚪";
}

function showFileDiff(file: PRFileDiff): void {
  if (!file.patch) return;

  console.log();
  const lines = file.patch.split("\n");
  lines.forEach((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      console.log(chalk.green(`  ${line}`));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      console.log(chalk.red(`  ${line}`));
    } else if (line.startsWith("@@")) {
      console.log(chalk.cyan(`  ${line}`));
    } else {
      console.log(chalk.gray(`  ${line}`));
    }
  });
  console.log();
}

function analyzeFilesForConcerns(files: PRFileDiff[]): CodeConcern[] {
  const concerns: CodeConcern[] = [];

  files.forEach((file) => {
    if (!file.patch) return;

    const lines = file.patch.split("\n");
    let lineNumber = 0;

    lines.forEach((line) => {
      // Track line numbers from @@ markers
      const hunkMatch = line.match(/@@ -\d+,?\d* \+(\d+),?\d* @@/);
      if (hunkMatch) {
        lineNumber = parseInt(hunkMatch[1]!, 10) - 1;
        return;
      }

      if (line.startsWith("+") && !line.startsWith("+++")) {
        lineNumber++;
        const code = line.slice(1);

        // Check for common issues
        if (/console\.(log|debug|info)/.test(code)) {
          concerns.push({
            file: file.filename,
            line: lineNumber,
            severity: "low",
            type: "style",
            message: "Console statement found",
            suggestion: "Remove console statements before merging",
          });
        }

        if (/TODO|FIXME|HACK|XXX/.test(code)) {
          concerns.push({
            file: file.filename,
            line: lineNumber,
            severity: "low",
            type: "other",
            message: "TODO/FIXME comment found",
            suggestion: "Address or create a ticket for this TODO",
          });
        }

        if (
          /password|secret|api[_-]?key/i.test(code) &&
          !code.includes("process.env")
        ) {
          concerns.push({
            file: file.filename,
            line: lineNumber,
            severity: "critical",
            type: "security",
            message: "Potential hardcoded secret",
            suggestion: "Use environment variables for secrets",
          });
        }

        if (code.length > 150) {
          concerns.push({
            file: file.filename,
            line: lineNumber,
            severity: "low",
            type: "style",
            message: "Line exceeds 150 characters",
            suggestion: "Consider breaking into multiple lines",
          });
        }

        if (/any\s*[;,)\]}]/.test(code) && file.filename.endsWith(".ts")) {
          concerns.push({
            file: file.filename,
            line: lineNumber,
            severity: "medium",
            type: "style",
            message: "Usage of 'any' type",
            suggestion: "Consider using a more specific type",
          });
        }

        if (/eval\(|new Function\(/.test(code)) {
          concerns.push({
            file: file.filename,
            line: lineNumber,
            severity: "high",
            type: "security",
            message: "eval() or Function constructor used",
            suggestion: "Avoid eval - it's a security risk",
          });
        }

        if (/\.innerHTML\s*=/.test(code)) {
          concerns.push({
            file: file.filename,
            line: lineNumber,
            severity: "medium",
            type: "security",
            message: "Direct innerHTML assignment",
            suggestion: "Consider using textContent or sanitizing input",
          });
        }
      } else if (!line.startsWith("-")) {
        lineNumber++;
      }
    });

    // File-level concerns
    if (file.additions > 500) {
      concerns.push({
        file: file.filename,
        line: 1,
        severity: "medium",
        type: "complexity",
        message: `Large file change (${file.additions} additions)`,
        suggestion: "Consider breaking into smaller PRs",
      });
    }
  });

  return concerns;
}

function getSeverityColor(severity: string): (text: string) => string {
  const colors: Record<string, (text: string) => string> = {
    low: chalk.blue,
    medium: chalk.yellow,
    high: chalk.red,
    critical: chalk.bgRed.white,
  };
  return colors[severity] || chalk.white;
}

function getSeverityIcon(severity: string): string {
  const icons: Record<string, string> = {
    low: "💡",
    medium: "⚠️",
    high: "🔴",
    critical: "🚨",
  };
  return icons[severity] || "❓";
}

function groupFilesByExtension(
  files: PRFileDiff[],
): Record<string, PRFileDiff[]> {
  return files.reduce(
    (acc, file) => {
      const ext = file.filename.split(".").pop() || "";
      if (!acc[ext]) acc[ext] = [];
      acc[ext].push(file);
      return acc;
    },
    {} as Record<string, PRFileDiff[]>,
  );
}
