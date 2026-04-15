#!/usr/bin/env node
/**
 * 🚀 Kuzo MCP CLI
 * The most glorious PR automation tool ever created
 */

// Side-effect import: loads `.env` before any command module evaluates.
// Must stay the first import so env vars are available to all subsequent
// modules during ESM dependency evaluation.
import "./bootstrap.js";

import { Command } from "commander";
import chalk from "chalk";
import {
  createPRInteractive,
  updatePRInteractive,
  listPRsInteractive,
} from "./commands/pr.js";
import { setupInteractive, showStatus } from "./commands/config.js";
import {
  createRepoInteractive,
  updateReadmeInteractive,
  updateVisibilityInteractive,
  checkIssuesInteractive,
  listReposInteractive,
} from "./commands/repo.js";
import { openPRInteractive } from "./commands/review.js";
import {
  myTicketsInteractive,
  myReviewsInteractive,
  moveTicketInteractive,
  subtasksInteractive,
  workflowInteractive,
  addCommentInteractive,
  searchTicketsInteractive,
} from "./commands/jira.js";
import {
  consentInteractive,
  permissionsInteractive,
  revokeInteractive,
  auditInteractive,
} from "./commands/consent.js";
import { showBanner, showGoodbye, showError } from "./ui/display.js";

/** Inline replacement for the deleted `utils/config.ts` helper. */
function isConfigured(): boolean {
  return !!process.env["GITHUB_TOKEN"] && !!process.env["GITHUB_USERNAME"];
}

const program = new Command();

program
  .name("kuzo")
  .description("🚀 PR Automation & GitHub Integration Tool")
  .version("1.0.0", "-v, --version", "Display version")
  .hook("preAction", (thisCommand) => {
    // Check config before most commands (except setup and help)
    const commandName = thisCommand.args[0];
    const noConfigCommands = ["setup", "config", "consent", "permissions", "revoke", "audit"];
    if (
      !noConfigCommands.includes(commandName ?? "") &&
      !thisCommand.opts()["help"]
    ) {
      if (!isConfigured()) {
        showError(
          "Kuzo MCP is not configured yet!",
          `Run ${chalk.cyan("kuzo setup")} to get started.`,
        );
        process.exit(1);
      }
    }
  });

// ============================================
// Setup Command
// ============================================
program
  .command("setup")
  .description("🧙‍♂️ Interactive setup wizard")
  .action(async () => {
    await setupInteractive();
    showGoodbye();
  });

// ============================================
// Config Commands
// ============================================
const configCmd = program
  .command("config")
  .description("⚙️ Configuration management");

configCmd
  .command("status")
  .description("Show current configuration status")
  .action(async () => {
    await showStatus();
  });

configCmd
  .command("setup")
  .description("Run the setup wizard")
  .action(async () => {
    await setupInteractive();
    showGoodbye();
  });

// ============================================
// PR Commands
// ============================================
const prCmd = program.command("pr").description("🔀 Pull request management");

prCmd
  .command("create")
  .alias("new")
  .description("Create a new pull request")
  .option("-r, --repo <repo>", "Repository (owner/repo or URL)")
  .option("-s, --source <branch>", "Source branch")
  .option("-t, --target <branch>", "Target branch")
  .option("-d, --draft", "Create as draft")
  .action(async () => {
    // For now, always use interactive mode
    // TODO: Support non-interactive with flags
    await createPRInteractive();
    showGoodbye();
  });

prCmd
  .command("update")
  .alias("edit")
  .description("Update an existing pull request")
  .option("-r, --repo <repo>", "Repository (owner/repo or URL)")
  .option("-n, --number <number>", "PR number")
  .action(async () => {
    await updatePRInteractive();
    showGoodbye();
  });

prCmd
  .command("list")
  .alias("ls")
  .description("List pull requests")
  .option("-r, --repo <repo>", "Repository (owner/repo or URL)")
  .option("-s, --state <state>", "PR state (open/closed/all)", "open")
  .action(async () => {
    await listPRsInteractive();
    showGoodbye();
  });

// ============================================
// Repo Commands
// ============================================
const repoCmd = program.command("repo").description("📦 Repository management");

repoCmd
  .command("create")
  .alias("new")
  .description("Create a new GitHub repository")
  .action(async () => {
    await createRepoInteractive();
    showGoodbye();
  });

repoCmd
  .command("list")
  .alias("ls")
  .description("List your repositories")
  .action(async () => {
    await listReposInteractive();
    showGoodbye();
  });

repoCmd
  .command("readme")
  .alias("update-readme")
  .description("Update repository README")
  .option("-r, --repo <repo>", "Repository (owner/repo or URL)")
  .action(async () => {
    await updateReadmeInteractive();
    showGoodbye();
  });

repoCmd
  .command("visibility")
  .alias("vis")
  .description("Toggle repository visibility (public/private)")
  .option("-r, --repo <repo>", "Repository (owner/repo or URL)")
  .action(async () => {
    await updateVisibilityInteractive();
    showGoodbye();
  });

repoCmd
  .command("issues")
  .description("Check issue status for a repository")
  .option("-r, --repo <repo>", "Repository (owner/repo or URL)")
  .action(async () => {
    await checkIssuesInteractive();
    showGoodbye();
  });

// ============================================
// Review Commands (PR Code Review)
// ============================================
const reviewCmd = program.command("review").description("🔍 PR code review");

reviewCmd
  .command("open")
  .alias("find")
  .description("Open a PR by repo name and branch")
  .action(async () => {
    await openPRInteractive();
    showGoodbye();
  });

// ============================================
// JIRA Commands
// ============================================
const jiraCmd = program.command("jira").description("🎫 JIRA integration");

jiraCmd
  .command("mine")
  .alias("tickets")
  .description("View your assigned tickets")
  .action(async () => {
    await myTicketsInteractive();
    showGoodbye();
  });

jiraCmd
  .command("reviews")
  .alias("cr")
  .description("View your code review subtasks")
  .action(async () => {
    await myReviewsInteractive();
    showGoodbye();
  });

jiraCmd
  .command("move")
  .description("Move a ticket to different status")
  .option("-t, --ticket <key>", "Ticket key (e.g., PROJ-123)")
  .action(async (options: { ticket?: string }) => {
    await moveTicketInteractive(options.ticket);
    showGoodbye();
  });

jiraCmd
  .command("subtasks")
  .alias("sub")
  .description("View and manage subtasks")
  .action(async () => {
    await subtasksInteractive();
    showGoodbye();
  });

jiraCmd
  .command("workflow")
  .alias("wf")
  .description("Create workflow subtasks (DEV, QA, etc.)")
  .action(async () => {
    await workflowInteractive();
    showGoodbye();
  });

jiraCmd
  .command("comment")
  .alias("c")
  .description("Add comment to a ticket")
  .action(async () => {
    await addCommentInteractive();
    showGoodbye();
  });

jiraCmd
  .command("search")
  .alias("s")
  .description("Search tickets")
  .action(async () => {
    await searchTicketsInteractive();
    showGoodbye();
  });

// ============================================
// Security & Consent Commands
// ============================================
program
  .command("consent")
  .description("Review and grant plugin permissions")
  .action(async () => {
    await consentInteractive();
    showGoodbye();
  });

program
  .command("permissions")
  .alias("perms")
  .description("List all plugin permission grants")
  .action(async () => {
    await permissionsInteractive();
    showGoodbye();
  });

program
  .command("revoke")
  .description("Revoke consent for a plugin")
  .argument("[plugin]", "Plugin name to revoke")
  .action(async (pluginArg?: string) => {
    await revokeInteractive(pluginArg);
    showGoodbye();
  });

program
  .command("audit")
  .description("View the security audit log")
  .option("-s, --since <duration>", "Time range (e.g., 7d, 24h, 2026-04-01)")
  .action(async (options: { since?: string }) => {
    await auditInteractive(options.since);
    showGoodbye();
  });

// ============================================
// Interactive Mode (default)
// ============================================
program
  .command("interactive", { isDefault: true })
  .alias("i")
  .description("🎮 Interactive mode")
  .action(async () => {
    const inquirer = await import("inquirer");

    showBanner();

    if (!isConfigured()) {
      const { runSetup } = await inquirer.default.prompt<{ runSetup: boolean }>(
        [
          {
            type: "confirm",
            name: "runSetup",
            message: "Kuzo MCP isn't configured yet. Run setup wizard?",
            default: true,
          },
        ],
      );

      if (runSetup) {
        await setupInteractive();
      }
      showGoodbye();
      return;
    }

    const { action } = await inquirer.default.prompt<{ action: string }>([
      {
        type: "list",
        name: "action",
        message: "What would you like to do?",
        choices: [
          new inquirer.default.Separator("─── Code Review ───"),
          { name: "🔍 Open PR for Review", value: "review-open" },
          new inquirer.default.Separator("─── JIRA ───"),
          { name: "🎫 My Tickets", value: "jira-mine" },
          { name: "📝 My Code Reviews", value: "jira-reviews" },
          { name: "📍 Move Ticket", value: "jira-move" },
          { name: "📋 Manage Subtasks", value: "jira-subtasks" },
          { name: "⚡ Create Workflow Subtasks", value: "jira-workflow" },
          { name: "💬 Add Comment", value: "jira-comment" },
          { name: "🔎 Search Tickets", value: "jira-search" },
          new inquirer.default.Separator("─── Pull Requests ───"),
          { name: "🆕 Create a PR", value: "pr-create" },
          { name: "✏️  Update a PR", value: "pr-update" },
          { name: "📋 List PRs", value: "pr-list" },
          new inquirer.default.Separator("─── Repositories ───"),
          { name: "📦 Create a Repo", value: "repo-create" },
          { name: "📄 Update README", value: "repo-readme" },
          { name: "🔒 Toggle Visibility", value: "repo-visibility" },
          { name: "🐛 Check Issues", value: "repo-issues" },
          { name: "📚 List My Repos", value: "repo-list" },
          new inquirer.default.Separator("─── Security ───"),
          { name: "🔐 Review Plugin Consent", value: "consent" },
          { name: "📋 View Permissions", value: "permissions" },
          { name: "🚫 Revoke Plugin Consent", value: "revoke" },
          { name: "📜 View Audit Log", value: "audit" },
          new inquirer.default.Separator("─── Settings ───"),
          { name: "⚙️  Check Config", value: "config" },
          { name: "🔧 Run Setup", value: "setup" },
          new inquirer.default.Separator("────────────────────"),
          { name: "👋 Exit", value: "exit" },
        ],
      },
    ]);

    switch (action) {
      // Review commands
      case "review-open":
        await openPRInteractive();
        break;
      // JIRA commands
      case "jira-mine":
        await myTicketsInteractive();
        break;
      case "jira-reviews":
        await myReviewsInteractive();
        break;
      case "jira-move":
        await moveTicketInteractive();
        break;
      case "jira-subtasks":
        await subtasksInteractive();
        break;
      case "jira-workflow":
        await workflowInteractive();
        break;
      case "jira-comment":
        await addCommentInteractive();
        break;
      case "jira-search":
        await searchTicketsInteractive();
        break;
      // PR commands
      case "pr-create":
        await createPRInteractive();
        break;
      case "pr-update":
        await updatePRInteractive();
        break;
      case "pr-list":
        await listPRsInteractive();
        break;
      // Repo commands
      case "repo-create":
        await createRepoInteractive();
        break;
      case "repo-readme":
        await updateReadmeInteractive();
        break;
      case "repo-visibility":
        await updateVisibilityInteractive();
        break;
      case "repo-issues":
        await checkIssuesInteractive();
        break;
      case "repo-list":
        await listReposInteractive();
        break;
      // Security commands
      case "consent":
        await consentInteractive();
        break;
      case "permissions":
        await permissionsInteractive();
        break;
      case "revoke":
        await revokeInteractive();
        break;
      case "audit":
        await auditInteractive();
        break;
      // Config commands
      case "config":
        await showStatus();
        break;
      case "setup":
        await setupInteractive();
        break;
      case "exit":
      default:
        break;
    }

    showGoodbye();
  });

// Parse and run
program.parse();
