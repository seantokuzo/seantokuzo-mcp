/**
 * 🔀 PR Commands
 * Create, update, list, and manage pull requests
 */

import inquirer from "inquirer";
import chalk from "chalk";
import { spawn } from "child_process";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
 * Get the user's preferred editor
 * Falls back to common editors if EDITOR/VISUAL not set
 */
function getEditor(): string {
  return (
    process.env.VISUAL ||
    process.env.EDITOR ||
    (process.platform === "darwin" ? "code --wait" : "nano")
  );
}

/**
 * Open an editor and get the content back
 * Creates a temp .md file, opens it in the editor, waits for close, returns content
 */
async function openEditorForDescription(
  initialContent: string = "",
  filename: string = "PR_DESCRIPTION.md",
): Promise<string> {
  const tempPath = join(tmpdir(), `sean-mcp-${Date.now()}-${filename}`);

  // Write initial content to temp file
  const template =
    initialContent ||
    `<!-- 
Write your PR description here.
Save and close this file when done.
Lines starting with <!-- will be removed.
-->

`;
  writeFileSync(tempPath, template, "utf-8");

  const editor = getEditor();
  const [cmd, ...args] = editor.split(" ");

  return new Promise((resolve, reject) => {
    console.log(
      chalk.gray(`  Opening ${chalk.cyan(editor)} for description...`),
    );
    console.log(chalk.gray(`  Save and close the file when done.\n`));

    const child = spawn(cmd!, [...args, tempPath], {
      stdio: "inherit",
      shell: true,
    });

    child.on("error", (error) => {
      // Clean up temp file
      try {
        unlinkSync(tempPath);
      } catch {}
      reject(
        new Error(
          `Failed to open editor: ${error.message}\nSet your EDITOR or VISUAL environment variable.`,
        ),
      );
    });

    child.on("close", (code) => {
      try {
        if (code !== 0) {
          unlinkSync(tempPath);
          reject(new Error(`Editor exited with code ${code}`));
          return;
        }

        // Read the content back
        const content = readFileSync(tempPath, "utf-8");
        unlinkSync(tempPath);

        // Remove HTML comments
        const cleaned = content.replace(/<!--[\s\S]*?-->/g, "").trim();

        resolve(cleaned);
      } catch (error) {
        reject(
          error instanceof Error ? error : new Error("Failed to read content"),
        );
      }
    });
  });
}

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

    // Get title first
    const { title } = await inquirer.prompt<{ title: string }>([
      {
        type: "input",
        name: "title",
        message: "📌 PR Title:",
        default: defaultTitle,
        validate: (input: string) => input.length > 0 || "Title is required",
      },
    ]);

    // Get changed files for better context
    const changedFiles = await github.getChangedFiles(
      repo,
      targetBranch,
      sourceBranch,
    );

    // Ask how they want to create the description
    const { descriptionMethod } = await inquirer.prompt<{
      descriptionMethod: "quick" | "editor" | "ai";
    }>([
      {
        type: "list",
        name: "descriptionMethod",
        message: "📝 How would you like to create the description?",
        choices: [
          {
            name: "⚡ Quick - Enter a brief description inline",
            value: "quick",
          },
          {
            name: `✏️  Editor - Open ${getEditor().split(" ")[0]} to write description`,
            value: "editor",
          },
          {
            name: "🤖 AI Generate - Give notes & let AI create the description",
            value: "ai",
          },
        ],
        default: "quick",
      },
    ]);

    let userContext = "";
    let body = "";

    if (descriptionMethod === "quick") {
      const { quickDesc } = await inquirer.prompt<{ quickDesc: string }>([
        {
          type: "input",
          name: "quickDesc",
          message: "📝 Brief description (optional):",
          default: "",
        },
      ]);
      userContext = quickDesc;
      body = generatePRDescription({
        title,
        commits,
        diffStats,
        userContext,
        sourceBranch,
        targetBranch,
        changedFiles,
      });
    } else if (descriptionMethod === "editor") {
      try {
        // Create a template with context
        const template = createEditorTemplate({
          title,
          commits,
          diffStats,
          sourceBranch,
          targetBranch,
          changedFiles,
        });
        userContext = await openEditorForDescription(template);

        // If they wrote a full description, use it; otherwise generate one
        if (userContext.includes("## ") || userContext.split("\n").length > 5) {
          // They wrote a full description
          body = userContext;
        } else {
          // They just wrote notes, generate the full description
          body = generatePRDescription({
            title,
            commits,
            diffStats,
            userContext,
            sourceBranch,
            targetBranch,
            changedFiles,
          });
        }
      } catch (error) {
        showError(
          "Editor failed",
          error instanceof Error ? error.message : "Unknown error",
        );
        showInfo("Falling back to quick input...");
        const { quickDesc } = await inquirer.prompt<{ quickDesc: string }>([
          {
            type: "input",
            name: "quickDesc",
            message: "📝 Brief description (optional):",
            default: "",
          },
        ]);
        userContext = quickDesc;
        body = generatePRDescription({
          title,
          commits,
          diffStats,
          userContext,
          sourceBranch,
          targetBranch,
          changedFiles,
        });
      }
    } else {
      // AI generation mode
      console.log();
      console.log(chalk.bold.cyan("  🤖 AI Description Generator"));
      console.log(
        chalk.gray(
          "     Give me some notes about what you changed and I'll generate a detailed description.",
        ),
      );
      console.log(
        chalk.gray(
          "     You can mention: what you built, testing done, breaking changes, etc.",
        ),
      );
      console.log();

      const { aiNotes } = await inquirer.prompt<{ aiNotes: string }>([
        {
          type: "input",
          name: "aiNotes",
          message: "📝 Your notes (what did you change/test?):",
        },
      ]);

      const aiSpinner = createStyledSpinner("Generating description");
      aiSpinner.start();

      // Generate an enhanced description using the notes + code context
      body = generateAIDescription({
        title,
        commits,
        diffStats,
        userNotes: aiNotes,
        sourceBranch,
        targetBranch,
        changedFiles,
      });

      aiSpinner.success({ text: "Description generated!" });
    }

    // Get draft preference
    const { isDraft } = await inquirer.prompt<{ isDraft: boolean }>([
      {
        type: "confirm",
        name: "isDraft",
        message: "📝 Create as draft PR?",
        default: config.defaults.draft,
      },
    ]);

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

      // Ask how they want to update the description
      const { descriptionMethod } = await inquirer.prompt<{
        descriptionMethod: "quick" | "editor" | "ai";
      }>([
        {
          type: "list",
          name: "descriptionMethod",
          message: "📝 How would you like to update the description?",
          choices: [
            {
              name: "⚡ Quick - Enter additional context inline",
              value: "quick",
            },
            {
              name: `✏️  Editor - Open ${getEditor().split(" ")[0]} to write description`,
              value: "editor",
            },
            {
              name: "🤖 AI Generate - Give notes & regenerate description",
              value: "ai",
            },
          ],
          default: "quick",
        },
      ]);

      const diffStats = {
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
      };

      if (descriptionMethod === "quick") {
        const { userContext } = await inquirer.prompt<{ userContext: string }>([
          {
            type: "input",
            name: "userContext",
            message: "📝 Additional context for the description:",
            default: "",
          },
        ]);

        newBody = generatePRDescription({
          title: newTitle,
          commits,
          diffStats,
          userContext,
          sourceBranch: pr.head.ref,
          targetBranch: pr.base.ref,
          existingBody: pr.body || undefined,
        });
      } else if (descriptionMethod === "editor") {
        try {
          const template = createEditorTemplate({
            title: newTitle,
            commits,
            diffStats,
            sourceBranch: pr.head.ref,
            targetBranch: pr.base.ref,
          });
          const editorContent = await openEditorForDescription(template);

          if (
            editorContent.includes("## ") ||
            editorContent.split("\n").length > 5
          ) {
            newBody = editorContent;
          } else {
            newBody = generatePRDescription({
              title: newTitle,
              commits,
              diffStats,
              userContext: editorContent,
              sourceBranch: pr.head.ref,
              targetBranch: pr.base.ref,
            });
          }
        } catch (error) {
          showError(
            "Editor failed",
            error instanceof Error ? error.message : "Unknown error",
          );
          showInfo("Falling back to quick input...");
          const { userContext } = await inquirer.prompt<{
            userContext: string;
          }>([
            {
              type: "input",
              name: "userContext",
              message: "📝 Additional context:",
              default: "",
            },
          ]);
          newBody = generatePRDescription({
            title: newTitle,
            commits,
            diffStats,
            userContext,
            sourceBranch: pr.head.ref,
            targetBranch: pr.base.ref,
          });
        }
      } else {
        // AI generation
        console.log();
        console.log(chalk.bold.cyan("  🤖 AI Description Generator"));
        console.log(
          chalk.gray(
            "     Give me notes about the changes to regenerate the description.",
          ),
        );
        console.log();

        const { aiNotes } = await inquirer.prompt<{ aiNotes: string }>([
          {
            type: "input",
            name: "aiNotes",
            message: "📝 Your notes (what changed/was tested?):",
          },
        ]);

        const aiSpinner = createStyledSpinner("Generating description");
        aiSpinner.start();

        newBody = generateAIDescription({
          title: newTitle,
          commits,
          diffStats,
          userNotes: aiNotes,
          sourceBranch: pr.head.ref,
          targetBranch: pr.base.ref,
        });

        aiSpinner.success({ text: "Description generated!" });
      }

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
  changedFiles?: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
}): string {
  const {
    commits,
    diffStats,
    userContext,
    sourceBranch,
    targetBranch,
    changedFiles,
  } = context;

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

  // Files changed (if available)
  if (changedFiles && changedFiles.length > 0) {
    sections.push("");
    sections.push("### 📁 Files Modified");
    const groupedFiles = groupFilesByDirectory(changedFiles);
    for (const [dir, files] of Object.entries(groupedFiles)) {
      if (dir) {
        sections.push(`\n**${dir}/**`);
      }
      files.slice(0, 10).forEach((file) => {
        const icon = getFileStatusIcon(file.status);
        const filename = dir
          ? file.filename.replace(`${dir}/`, "")
          : file.filename;
        sections.push(
          `- ${icon} \`${filename}\` (+${file.additions}/-${file.deletions})`,
        );
      });
      if (files.length > 10) {
        sections.push(`- ... and ${files.length - 10} more files`);
      }
    }
  }

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
    "*Generated by [Kuzo MCP](https://github.com/seantokuzo/seantokuzo-mcp) 🚀*",
  );

  return sections.join("\n");
}

/**
 * Generate an AI-enhanced description based on user notes and code context
 */
function generateAIDescription(context: {
  title: string;
  commits: Array<{ message: string; sha: string; author: string }>;
  diffStats: { additions: number; deletions: number; changedFiles: number };
  userNotes: string;
  sourceBranch: string;
  targetBranch: string;
  changedFiles?: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
}): string {
  const {
    commits,
    diffStats,
    userNotes,
    sourceBranch,
    targetBranch,
    changedFiles,
  } = context;

  const sections: string[] = [];

  // Analyze changes to infer what type of PR this is
  const analysis = analyzeChanges(commits, changedFiles || []);

  // Description section - enhanced with AI-style inference
  sections.push("## 📋 Description");

  if (userNotes && userNotes.trim()) {
    // Enhance the user's notes with context
    sections.push(userNotes.trim());
    sections.push("");
  }

  // Add inferred summary
  if (analysis.summary) {
    sections.push(analysis.summary);
  } else {
    sections.push(
      `This PR merges changes from \`${sourceBranch}\` into \`${targetBranch}\`.`,
    );
  }

  // What's Changed section
  if (analysis.categories.length > 0) {
    sections.push("");
    sections.push("### 🎯 What's Changed");
    analysis.categories.forEach((cat) => {
      sections.push(`- ${cat}`);
    });
  }

  // Changes summary
  sections.push("");
  sections.push("## 📊 Changes Summary");
  sections.push(`| Metric | Count |`);
  sections.push(`|--------|-------|`);
  sections.push(`| Files changed | ${diffStats.changedFiles} |`);
  sections.push(`| Additions | +${diffStats.additions} |`);
  sections.push(`| Deletions | -${diffStats.deletions} |`);

  // Key files section
  if (changedFiles && changedFiles.length > 0) {
    const keyFiles = changedFiles
      .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
      .slice(0, 5);

    sections.push("");
    sections.push("### 📁 Key Files");
    keyFiles.forEach((file) => {
      const icon = getFileStatusIcon(file.status);
      sections.push(
        `- ${icon} \`${file.filename}\` (+${file.additions}/-${file.deletions})`,
      );
    });
    if (changedFiles.length > 5) {
      sections.push(
        `\n<details><summary>View all ${changedFiles.length} changed files</summary>\n`,
      );
      changedFiles.slice(5).forEach((file) => {
        const icon = getFileStatusIcon(file.status);
        sections.push(
          `- ${icon} \`${file.filename}\` (+${file.additions}/-${file.deletions})`,
        );
      });
      sections.push("\n</details>");
    }
  }

  // Testing section - if user mentioned testing
  if (userNotes.toLowerCase().includes("test") || analysis.hasTests) {
    sections.push("");
    sections.push("## 🧪 Testing");
    if (userNotes.toLowerCase().includes("test")) {
      const testMatch = userNotes.match(/test[^.!?]*/i);
      sections.push(
        testMatch ? `- ${testMatch[0].trim()}` : "- Manual testing performed",
      );
    }
    if (analysis.hasTests) {
      sections.push("- Test files were added/modified in this PR");
    }
  }

  // Breaking changes - if mentioned
  if (
    userNotes.toLowerCase().includes("break") ||
    analysis.potentiallyBreaking
  ) {
    sections.push("");
    sections.push("## ⚠️ Breaking Changes");
    if (userNotes.toLowerCase().includes("break")) {
      sections.push(
        "Please review carefully - this PR may contain breaking changes.",
      );
    } else {
      sections.push(
        "This PR modifies core files - please review for potential breaking changes.",
      );
    }
  }

  // Commits section
  if (commits.length > 0) {
    sections.push("");
    sections.push("## 📝 Commits");
    commits.slice(0, 10).forEach((commit) => {
      const message = commit.message.split("\n")[0] || "";
      sections.push(`- \`${commit.sha.slice(0, 7)}\` ${message}`);
    });
    if (commits.length > 10) {
      sections.push(
        `\n<details><summary>View all ${commits.length} commits</summary>\n`,
      );
      commits.slice(10).forEach((commit) => {
        const message = commit.message.split("\n")[0] || "";
        sections.push(`- \`${commit.sha.slice(0, 7)}\` ${message}`);
      });
      sections.push("\n</details>");
    }
  }

  // Checklist
  sections.push("");
  sections.push("## ✅ Checklist");
  sections.push("- [ ] Code has been tested");
  sections.push("- [ ] Documentation updated (if needed)");
  sections.push("- [ ] No breaking changes (or documented if any)");
  if (analysis.hasTests) {
    sections.push("- [ ] All tests pass");
  }

  // Footer
  sections.push("");
  sections.push("---");
  sections.push(
    "*Generated by [Kuzo MCP](https://github.com/seantokuzo/seantokuzo-mcp) 🤖✨*",
  );

  return sections.join("\n");
}

/**
 * Analyze changes to infer PR type and categories
 */
function analyzeChanges(
  commits: Array<{ message: string; sha: string; author: string }>,
  changedFiles: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
  }>,
): {
  summary: string;
  categories: string[];
  hasTests: boolean;
  potentiallyBreaking: boolean;
} {
  const categories: string[] = [];
  let hasTests = false;
  let potentiallyBreaking = false;

  // Analyze file patterns
  const filePatterns = {
    frontend: /\.(tsx?|jsx?|css|scss|html)$/,
    backend: /(server|api|controller|router|middleware)/i,
    config: /\.(json|ya?ml|toml|env)/,
    docs: /\.(md|txt|rst)$/i,
    tests: /(test|spec)\.(tsx?|jsx?|py)$/i,
  };

  const fileCounts = {
    frontend: 0,
    backend: 0,
    config: 0,
    docs: 0,
    tests: 0,
  };

  changedFiles.forEach((file) => {
    if (filePatterns.frontend.test(file.filename)) fileCounts.frontend++;
    if (filePatterns.backend.test(file.filename)) fileCounts.backend++;
    if (filePatterns.config.test(file.filename)) fileCounts.config++;
    if (filePatterns.docs.test(file.filename)) fileCounts.docs++;
    if (filePatterns.tests.test(file.filename)) {
      fileCounts.tests++;
      hasTests = true;
    }

    // Check for potentially breaking changes
    if (
      file.filename.includes("package.json") ||
      file.filename.includes("tsconfig") ||
      file.status === "removed"
    ) {
      potentiallyBreaking = true;
    }
  });

  // Build categories
  if (fileCounts.frontend > 0) {
    categories.push(`🎨 Frontend changes (${fileCounts.frontend} files)`);
  }
  if (fileCounts.backend > 0) {
    categories.push(`⚙️ Backend changes (${fileCounts.backend} files)`);
  }
  if (fileCounts.config > 0) {
    categories.push(`🔧 Configuration updates`);
  }
  if (fileCounts.docs > 0) {
    categories.push(`📚 Documentation updates`);
  }
  if (fileCounts.tests > 0) {
    categories.push(`✅ Test updates (${fileCounts.tests} files)`);
  }

  // Analyze commit messages for conventional commits
  const commitTypes = new Set<string>();
  commits.forEach((commit) => {
    const match = commit.message.match(
      /^(feat|fix|docs|style|refactor|test|chore|perf|ci|build)(\(.+\))?:/i,
    );
    if (match) {
      commitTypes.add(match[1]!.toLowerCase());
    }
  });

  // Build summary
  let summary = "";
  if (commitTypes.has("feat")) {
    summary = "This PR introduces new features and functionality.";
  } else if (commitTypes.has("fix")) {
    summary = "This PR contains bug fixes and improvements.";
  } else if (commitTypes.has("refactor")) {
    summary = "This PR refactors existing code for better maintainability.";
  } else if (commitTypes.has("docs")) {
    summary = "This PR updates documentation.";
  }

  return { summary, categories, hasTests, potentiallyBreaking };
}

/**
 * Create a template for the editor with context
 */
function createEditorTemplate(context: {
  title: string;
  commits: Array<{ message: string; sha: string; author: string }>;
  diffStats: { additions: number; deletions: number; changedFiles: number };
  sourceBranch: string;
  targetBranch: string;
  changedFiles?: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
}): string {
  const { commits, diffStats, sourceBranch, targetBranch, changedFiles } =
    context;

  const lines: string[] = [
    "<!-- PR Description Template -->",
    "<!-- Write your description below. Save and close when done. -->",
    "<!-- Lines starting with <!-- will be removed. -->",
    "",
    "## What does this PR do?",
    "",
    "<!-- Describe your changes here -->",
    "",
    "",
    "## Why is this change needed?",
    "",
    "<!-- Explain the motivation -->",
    "",
    "",
    "## Testing done",
    "",
    "<!-- How did you test these changes? -->",
    "",
    "",
    "<!-- ═══════════════════════════════════════════════════════ -->",
    "<!-- CONTEXT (for reference - will be auto-removed) -->",
    `<!-- Branch: ${sourceBranch} → ${targetBranch} -->`,
    `<!-- Files: ${diffStats.changedFiles} changed (+${diffStats.additions}/-${diffStats.deletions}) -->`,
    "<!-- Recent commits: -->",
  ];

  commits.slice(0, 5).forEach((c) => {
    lines.push(
      `<!--   - ${c.sha.slice(0, 7)}: ${c.message.split("\n")[0]} -->`,
    );
  });

  if (changedFiles && changedFiles.length > 0) {
    lines.push("<!-- Key files changed: -->");
    changedFiles.slice(0, 8).forEach((f) => {
      lines.push(`<!--   - ${f.filename} -->`);
    });
  }

  lines.push(
    "<!-- ═══════════════════════════════════════════════════════ -->",
  );

  return lines.join("\n");
}

/**
 * Group files by their top-level directory
 */
function groupFilesByDirectory(
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
  }>,
): Record<
  string,
  Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
  }>
> {
  const grouped: Record<
    string,
    Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
    }>
  > = {};

  files.forEach((file) => {
    const parts = file.filename.split("/");
    const dir = parts.length > 1 ? parts[0]! : "";
    if (!grouped[dir]) {
      grouped[dir] = [];
    }
    grouped[dir].push(file);
  });

  return grouped;
}

/**
 * Get an icon for file status
 */
function getFileStatusIcon(status: string): string {
  switch (status) {
    case "added":
      return "🆕";
    case "removed":
      return "🗑️";
    case "modified":
      return "📝";
    case "renamed":
      return "📛";
    default:
      return "📄";
  }
}

export default {
  createPRInteractive,
  updatePRInteractive,
  listPRsInteractive,
};
