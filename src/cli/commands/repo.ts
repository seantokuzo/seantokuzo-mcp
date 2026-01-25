/**
 * 📦 Repo Commands
 * Create, update, and manage GitHub repositories
 */

import inquirer from "inquirer";
import chalk from "chalk";
import { getGitHubService } from "../../services/github.js";
import {
  showBanner,
  showSuccess,
  showError,
  showWarning,
  showInfo,
  displayRepoInfo,
  displayIssueStatus,
  createStyledSpinner,
  showBox,
} from "../ui/display.js";
import type { GitHubRepo } from "../../types/index.js";

// Common gitignore templates
const GITIGNORE_TEMPLATES = [
  { name: "None", value: undefined },
  { name: "Node", value: "Node" },
  { name: "Python", value: "Python" },
  { name: "Go", value: "Go" },
  { name: "Rust", value: "Rust" },
  { name: "Java", value: "Java" },
  { name: "Ruby", value: "Ruby" },
  { name: "Swift", value: "Swift" },
  { name: "C++", value: "C++" },
];

// Common license templates
const LICENSE_TEMPLATES = [
  { name: "None", value: undefined },
  { name: "MIT License", value: "mit" },
  { name: "Apache 2.0", value: "apache-2.0" },
  { name: "GPL 3.0", value: "gpl-3.0" },
  { name: "BSD 3-Clause", value: "bsd-3-clause" },
  { name: "ISC", value: "isc" },
  { name: "Unlicense", value: "unlicense" },
];

/**
 * Interactive repo creation flow
 */
export async function createRepoInteractive(): Promise<void> {
  showBanner();

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

    console.log();

    // Get repo name
    const { repoName } = await inquirer.prompt<{ repoName: string }>([
      {
        type: "input",
        name: "repoName",
        message: "📦 Repository name:",
        validate: (input: string) => {
          if (!input) return "Repository name is required";
          if (!/^[\w.-]+$/.test(input))
            return "Invalid name. Use letters, numbers, hyphens, underscores, and dots only.";
          return true;
        },
      },
    ]);

    // Get visibility
    const { isPrivate } = await inquirer.prompt<{ isPrivate: boolean }>([
      {
        type: "confirm",
        name: "isPrivate",
        message: "🔒 Make it private?",
        default: false,
      },
    ]);

    // Get description
    const { description } = await inquirer.prompt<{ description: string }>([
      {
        type: "input",
        name: "description",
        message: "📝 Description (optional):",
      },
    ]);

    // README options
    const { createReadme } = await inquirer.prompt<{ createReadme: boolean }>([
      {
        type: "confirm",
        name: "createReadme",
        message: "📄 Create a README.md?",
        default: true,
      },
    ]);

    let readmeContent: string | undefined;
    if (createReadme) {
      const { readmeOption } = await inquirer.prompt<{ readmeOption: string }>([
        {
          type: "list",
          name: "readmeOption",
          message: "📝 README content:",
          choices: [
            {
              name: "🤖 Let me generate it (describe what you want)",
              value: "generate",
            },
            { name: "✍️  Write it myself", value: "write" },
            {
              name: "📋 Simple template (just title & description)",
              value: "simple",
            },
          ],
        },
      ]);

      if (readmeOption === "generate") {
        const { readmePrompt } = await inquirer.prompt<{
          readmePrompt: string;
        }>([
          {
            type: "input",
            name: "readmePrompt",
            message: "🎯 Describe your project (I'll craft the README):",
            validate: (input: string) =>
              input.length > 0 || "Give me something to work with!",
          },
        ]);

        // For now, create a structured template based on user input
        // In the future, this could call an AI service
        readmeContent = generateReadmeFromPrompt(
          repoName,
          description,
          readmePrompt,
        );

        console.log();
        showBox(
          readmeContent.slice(0, 500) +
            (readmeContent.length > 500 ? "\n..." : ""),
          {
            title: "📄 Generated README Preview",
            borderColor: "cyan",
          },
        );

        const { confirmReadme } = await inquirer.prompt<{
          confirmReadme: boolean;
        }>([
          {
            type: "confirm",
            name: "confirmReadme",
            message: "Look good?",
            default: true,
          },
        ]);

        if (!confirmReadme) {
          const { editedReadme } = await inquirer.prompt<{
            editedReadme: string;
          }>([
            {
              type: "editor",
              name: "editedReadme",
              message: "Edit the README:",
              default: readmeContent,
            },
          ]);
          readmeContent = editedReadme;
        }
      } else if (readmeOption === "write") {
        const { customReadme } = await inquirer.prompt<{
          customReadme: string;
        }>([
          {
            type: "editor",
            name: "customReadme",
            message: "Write your README (opens editor):",
            default: `# ${repoName}\n\n${description || "Description goes here..."}\n`,
          },
        ]);
        readmeContent = customReadme;
      } else {
        // Simple template
        readmeContent = `# ${repoName}\n\n${description || ""}\n`;
      }
    }

    // Gitignore template
    const { gitignoreTemplate } = await inquirer.prompt<{
      gitignoreTemplate: string | undefined;
    }>([
      {
        type: "list",
        name: "gitignoreTemplate",
        message: "🙈 Add .gitignore template?",
        choices: GITIGNORE_TEMPLATES,
      },
    ]);

    // License
    const { licenseTemplate } = await inquirer.prompt<{
      licenseTemplate: string | undefined;
    }>([
      {
        type: "list",
        name: "licenseTemplate",
        message: "📜 Add a license?",
        choices: LICENSE_TEMPLATES,
      },
    ]);

    // Confirm creation
    console.log();
    console.log(chalk.bold("  📋 Summary:"));
    console.log(chalk.gray("  ─────────────────────────────────"));
    console.log(`  ${chalk.bold("Name:")} ${repoName}`);
    console.log(
      `  ${chalk.bold("Visibility:")} ${isPrivate ? chalk.yellow("Private 🔒") : chalk.green("Public 🌍")}`,
    );
    if (description)
      console.log(`  ${chalk.bold("Description:")} ${description}`);
    console.log(
      `  ${chalk.bold("README:")} ${createReadme ? chalk.green("Yes ✓") : chalk.gray("No")}`,
    );
    console.log(
      `  ${chalk.bold(".gitignore:")} ${gitignoreTemplate || chalk.gray("None")}`,
    );
    console.log(
      `  ${chalk.bold("License:")} ${licenseTemplate || chalk.gray("None")}`,
    );
    console.log(chalk.gray("  ─────────────────────────────────"));
    console.log();

    const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
      {
        type: "confirm",
        name: "confirm",
        message: "🚀 Create this repository?",
        default: true,
      },
    ]);

    if (!confirm) {
      showWarning("Repository creation cancelled.");
      return;
    }

    // Create the repo
    const createSpinner = createStyledSpinner("Creating repository");
    createSpinner.start();

    const repo = await github.createRepository({
      name: repoName,
      description: description || undefined,
      private: isPrivate,
      auto_init: createReadme && !readmeContent, // Only auto_init if no custom readme
      gitignore_template: gitignoreTemplate,
      license_template: licenseTemplate,
    });

    createSpinner.success({ text: "Repository created!" });

    // If we have custom readme content, push it
    if (readmeContent) {
      const readmeSpinner = createStyledSpinner("Creating README.md");
      readmeSpinner.start();

      await github.updateReadme(
        { owner: repo.owner.login, repo: repo.name },
        readmeContent,
        "Initial README.md 🚀",
      );

      readmeSpinner.success({ text: "README.md created!" });
    }

    // Show success with repo info
    displayRepoInfo(repo);
    showSuccess(`Repository ${repo.full_name} is ready!`);

    // Show helpful next steps
    showBox(
      [
        chalk.bold("Clone it:"),
        chalk.cyan(`  git clone ${repo.ssh_url}`),
        "",
        chalk.bold("Or add as remote:"),
        chalk.cyan(`  git remote add origin ${repo.ssh_url}`),
        chalk.cyan(`  git push -u origin main`),
      ].join("\n"),
      { title: "🚀 Next Steps", borderColor: "green" },
    );
  } catch (error) {
    showError(
      "Failed to create repository",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Interactive README update flow
 */
export async function updateReadmeInteractive(
  repo?: GitHubRepo,
): Promise<void> {
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

    // Get repo if not provided
    if (!repo) {
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

    // Fetch existing README
    const readmeSpinner = createStyledSpinner("Fetching current README");
    readmeSpinner.start();

    const existingReadme = await github.getReadme(repo);

    if (existingReadme) {
      readmeSpinner.success({ text: "README found!" });

      console.log();
      showBox(
        existingReadme.content.slice(0, 800) +
          (existingReadme.content.length > 800 ? "\n\n..." : ""),
        { title: "📄 Current README", borderColor: "gray" },
      );
    } else {
      readmeSpinner.success({ text: "No README exists yet" });
    }

    // Update options
    const { updateOption } = await inquirer.prompt<{ updateOption: string }>([
      {
        type: "list",
        name: "updateOption",
        message: "📝 How would you like to update the README?",
        choices: [
          {
            name: "🤖 Generate new content (describe what you want)",
            value: "generate",
          },
          { name: "✍️  Edit in editor", value: "edit" },
          { name: "📋 Replace entirely", value: "replace" },
        ],
      },
    ]);

    let newContent: string;

    if (updateOption === "generate") {
      const { readmePrompt } = await inquirer.prompt<{ readmePrompt: string }>([
        {
          type: "input",
          name: "readmePrompt",
          message: "🎯 Describe what you want in the README:",
        },
      ]);

      // Get repo info for better generation
      const repoInfo = await github.getRepoInfo(repo);
      newContent = generateReadmeFromPrompt(
        repoInfo.name,
        repoInfo.description || "",
        readmePrompt,
      );

      showBox(
        newContent.slice(0, 500) + (newContent.length > 500 ? "\n..." : ""),
        {
          title: "📄 Generated README Preview",
          borderColor: "cyan",
        },
      );

      const { confirmContent } = await inquirer.prompt<{
        confirmContent: boolean;
      }>([
        {
          type: "confirm",
          name: "confirmContent",
          message: "Use this content?",
          default: true,
        },
      ]);

      if (!confirmContent) {
        const { editedContent } = await inquirer.prompt<{
          editedContent: string;
        }>([
          {
            type: "editor",
            name: "editedContent",
            message: "Edit the README:",
            default: newContent,
          },
        ]);
        newContent = editedContent;
      }
    } else if (updateOption === "edit") {
      const { editedContent } = await inquirer.prompt<{
        editedContent: string;
      }>([
        {
          type: "editor",
          name: "editedContent",
          message: "Edit the README:",
          default: existingReadme?.content || "# README\n",
        },
      ]);
      newContent = editedContent;
    } else {
      const { newReadme } = await inquirer.prompt<{ newReadme: string }>([
        {
          type: "editor",
          name: "newReadme",
          message: "Write new README:",
          default: "# README\n",
        },
      ]);
      newContent = newReadme;
    }

    // Commit message
    const { commitMessage } = await inquirer.prompt<{ commitMessage: string }>([
      {
        type: "input",
        name: "commitMessage",
        message: "💬 Commit message:",
        default: existingReadme ? "Update README.md" : "Create README.md",
      },
    ]);

    // Update README
    const updateSpinner = createStyledSpinner("Updating README");
    updateSpinner.start();

    const result = await github.updateReadme(repo, newContent, commitMessage);

    updateSpinner.success({ text: "README updated!" });
    showSuccess(`README.md updated successfully!`);
    console.log(chalk.cyan(`  ${result.html_url}`));
  } catch (error) {
    showError(
      "Failed to update README",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Interactive visibility update flow
 */
export async function updateVisibilityInteractive(
  repo?: GitHubRepo,
): Promise<void> {
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

    // Get repo if not provided
    if (!repo) {
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

    // Get current repo info
    const infoSpinner = createStyledSpinner("Fetching repository info");
    infoSpinner.start();

    const repoInfo = await github.getRepoInfo(repo);
    infoSpinner.success({ text: "Got repo info!" });

    const currentVisibility = repoInfo.private ? "Private 🔒" : "Public 🌍";
    console.log();
    console.log(
      `  Current visibility: ${repoInfo.private ? chalk.yellow(currentVisibility) : chalk.green(currentVisibility)}`,
    );
    console.log();

    // Confirm change
    const { newVisibility } = await inquirer.prompt<{ newVisibility: boolean }>(
      [
        {
          type: "confirm",
          name: "newVisibility",
          message: repoInfo.private
            ? "🌍 Make this repository PUBLIC?"
            : "🔒 Make this repository PRIVATE?",
          default: false,
        },
      ],
    );

    if (newVisibility === repoInfo.private) {
      showInfo("No changes made.");
      return;
    }

    // Warning for public -> private
    if (repoInfo.private === false && newVisibility === true) {
      showWarning(
        "Making a repo private may affect existing forks and collaborators!",
      );
      const { confirmPrivate } = await inquirer.prompt<{
        confirmPrivate: boolean;
      }>([
        {
          type: "confirm",
          name: "confirmPrivate",
          message: "Are you sure?",
          default: false,
        },
      ]);

      if (!confirmPrivate) {
        showInfo("Cancelled.");
        return;
      }
    }

    // Update visibility
    const updateSpinner = createStyledSpinner("Updating visibility");
    updateSpinner.start();

    const updatedRepo = await github.updateRepository({
      repo,
      private: !repoInfo.private,
    });

    updateSpinner.success({ text: "Visibility updated!" });

    const newVis = updatedRepo.private ? "Private 🔒" : "Public 🌍";
    showSuccess(
      `${repo.owner}/${repo.repo} is now ${updatedRepo.private ? chalk.yellow(newVis) : chalk.green(newVis)}`,
    );
  } catch (error) {
    showError(
      "Failed to update visibility",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Check issues status for a repo
 */
export async function checkIssuesInteractive(repo?: GitHubRepo): Promise<void> {
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

    // Get repo if not provided
    if (!repo) {
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

    // Check issues
    const issueSpinner = createStyledSpinner("Checking issues");
    issueSpinner.start();

    const issueStatus = await github.checkIssues(repo);
    const repoInfo = await github.getRepoInfo(repo);

    issueSpinner.success({ text: "Got issue status!" });

    displayIssueStatus(repoInfo, issueStatus);

    // Offer to toggle if they want
    const { toggleIssues } = await inquirer.prompt<{ toggleIssues: boolean }>([
      {
        type: "confirm",
        name: "toggleIssues",
        message: issueStatus.enabled
          ? "🚫 Disable issues for this repo?"
          : "✅ Enable issues for this repo?",
        default: false,
      },
    ]);

    if (toggleIssues) {
      const toggleSpinner = createStyledSpinner(
        issueStatus.enabled ? "Disabling issues" : "Enabling issues",
      );
      toggleSpinner.start();

      await github.updateRepository({
        repo,
        has_issues: !issueStatus.enabled,
      });

      toggleSpinner.success({
        text: issueStatus.enabled ? "Issues disabled!" : "Issues enabled!",
      });
      showSuccess(
        `Issues are now ${issueStatus.enabled ? "disabled" : "enabled"} for ${repo.owner}/${repo.repo}`,
      );
    }
  } catch (error) {
    showError(
      "Failed to check issues",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * List user's repos interactively
 */
export async function listReposInteractive(): Promise<void> {
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

    // Fetch repos
    const repoSpinner = createStyledSpinner("Fetching your repositories");
    repoSpinner.start();

    const repos = await github.listMyRepos({ per_page: 20 });
    repoSpinner.success({ text: `Found ${repos.length} repositories` });

    // Display repos
    console.log();
    console.log(chalk.bold.cyan("  📦 Your Repositories"));
    console.log(chalk.gray("  ─────────────────────────────────────────"));

    repos.forEach((repo) => {
      const visIcon = repo.private ? "🔒" : "🌍";
      const name = chalk.white(repo.name);
      const desc = repo.description
        ? chalk.gray(
            ` - ${repo.description.slice(0, 40)}${repo.description.length > 40 ? "..." : ""}`,
          )
        : "";

      console.log(`  ${visIcon} ${name}${desc}`);
      console.log(
        chalk.gray(
          `     ⭐ ${repo.stargazers_count}  🍴 ${repo.forks_count}  📝 ${repo.open_issues_count} issues`,
        ),
      );
    });

    console.log(chalk.gray("  ─────────────────────────────────────────"));
    console.log();
  } catch (error) {
    showError(
      "Failed to list repositories",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Generate a README from user prompt
 * This is a template-based approach - could be enhanced with AI later
 */
function generateReadmeFromPrompt(
  repoName: string,
  description: string,
  userPrompt: string,
): string {
  const lines = [`# ${repoName}`, ""];

  if (description) {
    lines.push(`> ${description}`, "");
  }

  // Parse user intent from prompt
  const promptLower = userPrompt.toLowerCase();

  // Add description section
  lines.push("## About", "", `${userPrompt}`, "");

  // Detect common patterns and add sections
  if (
    promptLower.includes("api") ||
    promptLower.includes("server") ||
    promptLower.includes("backend")
  ) {
    lines.push(
      "## Getting Started",
      "",
      "### Prerequisites",
      "",
      "- Node.js 18+",
      "- npm or yarn",
      "",
      "### Installation",
      "",
      "```bash",
      `git clone https://github.com/YOUR_USERNAME/${repoName}.git`,
      `cd ${repoName}`,
      "npm install",
      "```",
      "",
      "### Running",
      "",
      "```bash",
      "npm run dev",
      "```",
      "",
    );
  } else if (promptLower.includes("cli") || promptLower.includes("command")) {
    lines.push(
      "## Installation",
      "",
      "```bash",
      `npm install -g ${repoName}`,
      "```",
      "",
      "## Usage",
      "",
      "```bash",
      `${repoName} --help`,
      "```",
      "",
    );
  } else if (
    promptLower.includes("library") ||
    promptLower.includes("package") ||
    promptLower.includes("npm")
  ) {
    lines.push(
      "## Installation",
      "",
      "```bash",
      `npm install ${repoName}`,
      "```",
      "",
      "## Usage",
      "",
      "```javascript",
      `import { something } from '${repoName}';`,
      "```",
      "",
    );
  } else {
    // Generic getting started
    lines.push(
      "## Getting Started",
      "",
      "```bash",
      `git clone https://github.com/YOUR_USERNAME/${repoName}.git`,
      `cd ${repoName}`,
      "```",
      "",
    );
  }

  // Add contributing section
  lines.push(
    "## Contributing",
    "",
    "Contributions are welcome! Please feel free to submit a Pull Request.",
    "",
    "## License",
    "",
    "This project is licensed under the MIT License.",
    "",
  );

  return lines.join("\n");
}
