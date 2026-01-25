#!/usr/bin/env node
/**
 * 🚀 Sean-MCP CLI
 * The most glorious PR automation tool ever created
 */

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
import { showBanner, showGoodbye, showError } from "./ui/display.js";
import { isConfigured } from "../utils/config.js";

const program = new Command();

program
  .name("sean-mcp")
  .description("🚀 PR Automation & GitHub Integration Tool")
  .version("1.0.0", "-v, --version", "Display version")
  .hook("preAction", (thisCommand) => {
    // Check config before most commands (except setup and help)
    const commandName = thisCommand.args[0];
    if (
      commandName !== "setup" &&
      commandName !== "config" &&
      !thisCommand.opts()["help"]
    ) {
      if (!isConfigured()) {
        showError(
          "Sean-MCP is not configured yet!",
          `Run ${chalk.cyan("sean-mcp setup")} to get started.`,
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
            message: "Sean-MCP isn't configured yet. Run setup wizard?",
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
          new inquirer.default.Separator("─── Settings ───"),
          { name: "⚙️  Check Config", value: "config" },
          { name: "🔧 Run Setup", value: "setup" },
          new inquirer.default.Separator("────────────────────"),
          { name: "👋 Exit", value: "exit" },
        ],
      },
    ]);

    switch (action) {
      case "pr-create":
        await createPRInteractive();
        break;
      case "pr-update":
        await updatePRInteractive();
        break;
      case "pr-list":
        await listPRsInteractive();
        break;
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
