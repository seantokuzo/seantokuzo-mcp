/**
 * 🎨 CLI Display utilities
 * Making the terminal beautiful since 2026
 */

import chalk from "chalk";
import boxen from "boxen";
import figlet from "figlet";
import gradient from "gradient-string";
import { createSpinner } from "nanospinner";
import { getRandomMessage, type MessageType } from "./messages.js";
import type {
  PullRequestInfo,
  RepoInfo,
} from "@kuzo-mcp/plugin-github/types";

type Personality = "professional" | "chaotic" | "zen";

/** Resolve CLI personality from env, defaulting to "chaotic" on missing/invalid. */
function getPersonality(): Personality {
  const raw = process.env["CLI_PERSONALITY"] ?? "chaotic";
  const allowed = ["professional", "chaotic", "zen"] as const;
  return (allowed as readonly string[]).includes(raw)
    ? (raw as Personality)
    : "chaotic";
}

// Custom gradients
const kuzoGradient = gradient(["#FF6B6B", "#4ECDC4", "#45B7D1"]);
const successGradient = gradient(["#56ab2f", "#a8e063"]);
const errorGradient = gradient(["#ED213A", "#93291E"]);
const infoGradient = gradient(["#2193b0", "#6dd5ed"]);

/**
 * Display the epic banner
 */
export function showBanner(): void {
  console.log();
  console.log(
    kuzoGradient(
      figlet.textSync("KUZO MCP", {
        font: "ANSI Shadow",
        horizontalLayout: "fitted",
      }),
    ),
  );

  console.log(
    chalk.gray("  ─────────────────────────────────────────────────────"),
  );
  console.log(
    chalk.cyan("  🚀 PR Automation • GitHub Integration • Pure Vibes"),
  );
  console.log(
    chalk.gray("  ─────────────────────────────────────────────────────"),
  );
  console.log();

  // Random welcome message based on personality
  console.log(chalk.yellow(getRandomMessage("welcome", getPersonality())));
  console.log();
}

/**
 * Show a styled message box
 */
export function showBox(
  content: string,
  options?: {
    title?: string;
    borderColor?: string;
    padding?: number;
  },
): void {
  console.log(
    boxen(content, {
      padding: options?.padding ?? 1,
      margin: 1,
      borderStyle: "round",
      borderColor: options?.borderColor || "cyan",
      title: options?.title,
      titleAlignment: "center",
    }),
  );
}

/**
 * Show success message
 */
export function showSuccess(message: string): void {
  console.log();
  console.log(successGradient("  ✅ SUCCESS"));
  console.log(chalk.green(`  ${message}`));
  console.log();
  console.log(chalk.gray(`  ${getRandomMessage("success", getPersonality())}`));
  console.log();
}

/**
 * Show error message
 */
export function showError(message: string, details?: string): void {
  console.log();
  console.log(errorGradient("  ❌ ERROR"));
  console.log(chalk.red(`  ${message}`));
  if (details) {
    console.log(chalk.gray(`  ${details}`));
  }
  console.log();
  console.log(chalk.gray(`  ${getRandomMessage("error", getPersonality())}`));
  console.log();
}

/**
 * Show warning message
 */
export function showWarning(message: string): void {
  console.log();
  console.log(chalk.yellow("  ⚠️  WARNING"));
  console.log(chalk.yellow(`  ${message}`));
  console.log();
}

/**
 * Show info message
 */
export function showInfo(message: string): void {
  console.log();
  console.log(infoGradient("  ℹ️  INFO"));
  console.log(chalk.cyan(`  ${message}`));
  console.log();
}

/**
 * Create a spinner with personality
 */
export function createStyledSpinner(text: string) {
  const spinnerText = `${text} ${chalk.gray(getRandomMessage("thinking", getPersonality()))}`;

  return createSpinner(spinnerText, {
    color: "cyan",
    frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  });
}

/**
 * Display PR info in a nice format
 */
export function displayPRInfo(pr: PullRequestInfo): void {
  const statusColor =
    pr.state === "open"
      ? pr.draft
        ? chalk.gray
        : chalk.green
      : pr.state === "closed"
        ? chalk.red
        : chalk.magenta;

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

/**
 * Display a list of PRs
 */
export function displayPRList(prs: PullRequestInfo[]): void {
  if (prs.length === 0) {
    showInfo("No pull requests found.");
    return;
  }

  console.log();
  console.log(chalk.bold.cyan("  📋 Pull Requests"));
  console.log(chalk.gray("  ─────────────────────────────────────────"));

  prs.forEach((pr, index) => {
    const statusIcon = pr.draft ? "📝" : pr.state === "open" ? "🟢" : "🔴";
    const number = chalk.gray(`#${pr.number}`);
    const title = chalk.white(
      pr.title.slice(0, 50) + (pr.title.length > 50 ? "..." : ""),
    );
    const branch = chalk.cyan(pr.head.ref);

    console.log(`  ${statusIcon} ${number} ${title}`);
    console.log(`     ${chalk.gray("↳")} ${branch} → ${pr.base.ref}`);
    if (index < prs.length - 1) {
      console.log();
    }
  });

  console.log(chalk.gray("  ─────────────────────────────────────────"));
  console.log();
}

/**
 * Show goodbye message
 */
export function showGoodbye(): void {
  console.log();
  console.log(chalk.gray("─────────────────────────────────────────"));
  console.log(kuzoGradient(getRandomMessage("goodbye", getPersonality())));
  console.log(chalk.gray("─────────────────────────────────────────"));
  console.log();
}

/**
 * Show configuration status
 */
export function showConfigStatus(configured: boolean, username?: string): void {
  if (configured && username) {
    showBox(
      `${chalk.green("✓")} Connected to GitHub as ${chalk.bold.cyan(username)}`,
      { title: "🔐 Configuration", borderColor: "green" },
    );
  } else {
    showBox(
      [
        `${chalk.red("✗")} GitHub not configured`,
        "",
        `${chalk.yellow("To set up:")}`,
        `  1. Copy ${chalk.cyan(".env.example")} to ${chalk.cyan(".env")}`,
        `  2. Add your GitHub token`,
        `  3. Set your GitHub username`,
      ].join("\n"),
      { title: "🔐 Configuration Required", borderColor: "red" },
    );
  }
}

/**
 * Display divider
 */
export function divider(): void {
  console.log(
    chalk.gray("  ─────────────────────────────────────────────────"),
  );
}

/**
 * Message with personality
 */
export function say(type: MessageType): void {
  console.log(chalk.gray(`  ${getRandomMessage(type, getPersonality())}`));
}

/**
 * Display repository info in a nice format
 */
export function displayRepoInfo(repo: RepoInfo): void {
  const visibilityIcon = repo.private ? "🔒" : "🌍";
  const visibilityText = repo.private
    ? chalk.yellow("Private")
    : chalk.green("Public");

  const content = [
    `${chalk.bold("Name:")} ${repo.name}`,
    `${chalk.bold("Full Name:")} ${repo.full_name}`,
    `${chalk.bold("Visibility:")} ${visibilityIcon} ${visibilityText}`,
    repo.description ? `${chalk.bold("Description:")} ${repo.description}` : "",
    "",
    `${chalk.bold("Default Branch:")} ${chalk.cyan(repo.default_branch)}`,
    `${chalk.bold("Stats:")} ⭐ ${repo.stargazers_count}  🍴 ${repo.forks_count}  📝 ${repo.open_issues_count} issues`,
    "",
    `${chalk.bold("Clone (SSH):")} ${chalk.cyan(repo.ssh_url)}`,
    `${chalk.bold("Clone (HTTPS):")} ${chalk.cyan(repo.clone_url)}`,
    "",
    `${chalk.bold("URL:")} ${chalk.underline.blue(repo.html_url)}`,
  ]
    .filter(Boolean)
    .join("\n");

  showBox(content, {
    title: "📦 Repository",
    borderColor: repo.private ? "yellow" : "green",
  });
}

/**
 * Display issue status for a repo
 */
export function displayIssueStatus(
  repo: RepoInfo,
  issueStatus: { enabled: boolean; open_count: number; closed_count?: number },
): void {
  const statusIcon = issueStatus.enabled ? "✅" : "🚫";
  const statusText = issueStatus.enabled
    ? chalk.green("Enabled")
    : chalk.red("Disabled");

  const content = [
    `${chalk.bold("Repository:")} ${repo.full_name}`,
    "",
    `${chalk.bold("Issues:")} ${statusIcon} ${statusText}`,
  ];

  if (issueStatus.enabled) {
    content.push(
      "",
      `${chalk.bold("Open Issues:")} ${chalk.yellow(issueStatus.open_count.toString())}`,
    );
  }

  showBox(content.join("\n"), {
    title: "📋 Issue Status",
    borderColor: issueStatus.enabled ? "green" : "red",
  });
}
