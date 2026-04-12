/**
 * 🎫 JIRA Commands
 * Move tickets, trigger workflows, manage subtasks
 */

import inquirer from "inquirer";
import chalk from "chalk";
import { JiraClient } from "../../plugins/jira/client.js";
import {
  showBanner,
  showSuccess,
  showError,
  showWarning,
  showInfo,
  showBox,
  createStyledSpinner,
} from "../ui/display.js";
import type { JiraTicket, JiraSubtask } from "../../plugins/jira/types.js";

/**
 * Construct a JiraClient from environment variables.
 *
 * Validates required env vars up front and throws a message listing exactly
 * which ones are missing, so the outer try/catch on each exported function
 * surfaces a clear, actionable error via `showError` (vs. the `JiraClient`
 * constructor's generic "requires host, email, and token").
 */
function createJiraClient(): JiraClient {
  const host = process.env["JIRA_HOST"]?.trim() ?? "";
  const email = process.env["JIRA_EMAIL"]?.trim() ?? "";
  const token = process.env["JIRA_API_TOKEN"]?.trim() ?? "";

  const missing: string[] = [];
  if (!host) missing.push("JIRA_HOST");
  if (!email) missing.push("JIRA_EMAIL");
  if (!token) missing.push("JIRA_API_TOKEN");

  if (missing.length > 0) {
    throw new Error(
      `Missing required JIRA environment variables: ${missing.join(", ")}. Set them in your .env file (run \`kuzo setup\`).`,
    );
  }

  return new JiraClient({ host, email, token });
}

/**
 * View my assigned tickets
 */
export async function myTicketsInteractive(): Promise<void> {
  showBanner();

  try {
    const jira = createJiraClient();

    const spinner = createStyledSpinner("Connecting to JIRA");
    spinner.start();

    const connection = await jira.verifyConnection();
    if (!connection.valid) {
      spinner.error({ text: "Failed to connect to JIRA" });
      showError("JIRA authentication failed", connection.error);
      return;
    }
    spinner.success({
      text: `Connected as ${chalk.cyan(connection.displayName)}`,
    });

    const ticketSpinner = createStyledSpinner("Fetching your tickets");
    ticketSpinner.start();

    const tickets = await jira.getMyTickets();
    ticketSpinner.success({ text: `Found ${tickets.length} tickets` });

    if (tickets.length === 0) {
      showInfo("No tickets assigned to you");
      return;
    }

    console.log();
    displayTicketList(tickets);

    // Select a ticket
    const { selectedKey } = await inquirer.prompt<{ selectedKey: string }>([
      {
        type: "list",
        name: "selectedKey",
        message: "Select a ticket:",
        choices: [
          ...tickets.map((t) => ({
            name: `${chalk.yellow(t.key)} - ${t.summary.slice(0, 50)}${t.summary.length > 50 ? "..." : ""} [${getStatusColor(t.status.name)(t.status.name)}]`,
            value: t.key,
          })),
          { name: chalk.gray("← Back"), value: "__back__" },
        ],
      },
    ]);

    if (selectedKey === "__back__") return;

    const ticket = tickets.find((t) => t.key === selectedKey);
    if (ticket) {
      await ticketActionsMenu(ticket);
    }
  } catch (error) {
    showError(
      "Failed to fetch tickets",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * View my code review subtasks
 */
export async function myReviewsInteractive(): Promise<void> {
  showBanner();

  try {
    const jira = createJiraClient();

    const spinner = createStyledSpinner("Fetching your code review subtasks");
    spinner.start();

    const reviews = await jira.getMyCodeReviews();
    spinner.success({ text: `Found ${reviews.length} review subtasks` });

    if (reviews.length === 0) {
      showInfo("No code review subtasks assigned to you");
      return;
    }

    console.log();
    console.log(chalk.bold.cyan("  🔍 Your Code Reviews"));
    console.log(chalk.gray("  ─────────────────────────────────────────"));

    reviews.forEach((review) => {
      const statusColor = getStatusColor(review.status);
      console.log(
        `  ${chalk.yellow(review.key)} ${statusColor(review.status)}`,
      );
      console.log(`    ${chalk.white(review.summary)}`);
      if (review.parent) {
        console.log(`    ${chalk.gray("Parent:")} ${review.parent.key}`);
      }
      console.log();
    });

    // Select a review to move
    const { selectedKey } = await inquirer.prompt<{ selectedKey: string }>([
      {
        type: "list",
        name: "selectedKey",
        message: "Select a review to move:",
        choices: [
          ...reviews.map((r) => ({
            name: `${chalk.yellow(r.key)} - ${r.summary.slice(0, 40)}... [${getStatusColor(r.status)(r.status)}]`,
            value: r.key,
          })),
          { name: chalk.gray("← Back"), value: "__back__" },
        ],
      },
    ]);

    if (selectedKey === "__back__") return;

    const review = reviews.find((r) => r.key === selectedKey);
    if (review) {
      await moveTicketInteractive(review.key);
    }
  } catch (error) {
    showError(
      "Failed to fetch reviews",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Move a ticket to a different status
 */
export async function moveTicketInteractive(ticketKey?: string): Promise<void> {
  if (!ticketKey) {
    showBanner();
  }

  try {
    const jira = createJiraClient();

    // Get ticket key if not provided
    if (!ticketKey) {
      const { inputKey } = await inquirer.prompt<{ inputKey: string }>([
        {
          type: "input",
          name: "inputKey",
          message: "🎫 Ticket key (e.g., PROJ-123):",
          validate: (input: string) => {
            if (!input) return "Ticket key is required";
            if (!/^[A-Z]+-\d+$/i.test(input))
              return "Invalid ticket key format";
            return true;
          },
        },
      ]);
      ticketKey = inputKey.toUpperCase();
    }

    const spinner = createStyledSpinner(`Fetching ${ticketKey}`);
    spinner.start();

    const ticket = await jira.getTicket(ticketKey);
    const transitions = await jira.getTransitions(ticketKey);

    spinner.success({ text: "Ticket loaded" });

    // Display current status
    displayTicketDetails(ticket);

    if (transitions.length === 0) {
      showWarning("No transitions available for this ticket");
      return;
    }

    console.log();
    console.log(chalk.bold("  📍 Available Transitions:"));
    transitions.forEach((t, i) => {
      console.log(`     ${i + 1}. ${t.name}`);
    });
    console.log();

    const { transitionId } = await inquirer.prompt<{ transitionId: string }>([
      {
        type: "list",
        name: "transitionId",
        message: `Move ${chalk.yellow(ticketKey)} to:`,
        choices: [
          ...transitions.map((t) => ({
            name: t.name,
            value: t.id,
          })),
          { name: chalk.gray("← Cancel"), value: "__cancel__" },
        ],
      },
    ]);

    if (transitionId === "__cancel__") return;

    const moveSpinner = createStyledSpinner("Moving ticket");
    moveSpinner.start();

    await jira.transitionTicket(ticketKey, transitionId);

    const transition = transitions.find((t) => t.id === transitionId);
    moveSpinner.success({
      text: `Moved to ${transition?.name || "new status"}`,
    });

    showSuccess(`${ticketKey} moved successfully! 🎉`);
  } catch (error) {
    showError(
      "Failed to move ticket",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * View and manage ticket subtasks
 */
export async function subtasksInteractive(): Promise<void> {
  showBanner();

  try {
    const jira = createJiraClient();

    const { ticketKey } = await inquirer.prompt<{ ticketKey: string }>([
      {
        type: "input",
        name: "ticketKey",
        message: "🎫 Parent ticket key (e.g., PROJ-123):",
        validate: (input: string) => {
          if (!input) return "Ticket key is required";
          if (!/^[A-Z]+-\d+$/i.test(input)) return "Invalid ticket key format";
          return true;
        },
      },
    ]);

    const spinner = createStyledSpinner(
      `Fetching subtasks for ${ticketKey.toUpperCase()}`,
    );
    spinner.start();

    const subtasks = await jira.getSubtasks(ticketKey.toUpperCase());
    spinner.success({ text: `Found ${subtasks.length} subtasks` });

    if (subtasks.length === 0) {
      showInfo("No subtasks found for this ticket");

      const { createOne } = await inquirer.prompt<{ createOne: boolean }>([
        {
          type: "confirm",
          name: "createOne",
          message: "Create a subtask?",
          default: false,
        },
      ]);

      if (createOne) {
        await createSubtaskInteractive(ticketKey.toUpperCase());
      }
      return;
    }

    displaySubtaskList(subtasks);

    const { action } = await inquirer.prompt<{ action: string }>([
      {
        type: "list",
        name: "action",
        message: "What would you like to do?",
        choices: [
          { name: "📝 Move a subtask", value: "move" },
          { name: "✏️  Update a subtask", value: "update" },
          { name: "➕ Create new subtask", value: "create" },
          { name: "💬 Add comment to subtask", value: "comment" },
          { name: "👋 Exit", value: "exit" },
        ],
      },
    ]);

    switch (action) {
      case "move":
        await selectAndMoveSubtask(subtasks);
        break;
      case "update":
        await selectAndUpdateSubtask(subtasks);
        break;
      case "create":
        await createSubtaskInteractive(ticketKey.toUpperCase());
        break;
      case "comment":
        await selectAndCommentSubtask(subtasks);
        break;
    }
  } catch (error) {
    showError(
      "Failed to manage subtasks",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Create workflow subtasks (DEV, QA, etc.)
 */
export async function workflowInteractive(): Promise<void> {
  showBanner();

  try {
    const jira = createJiraClient();

    const { ticketKey } = await inquirer.prompt<{ ticketKey: string }>([
      {
        type: "input",
        name: "ticketKey",
        message: "🎫 Parent ticket key (e.g., PROJ-123):",
        validate: (input: string) => {
          if (!input) return "Ticket key is required";
          if (!/^[A-Z]+-\d+$/i.test(input)) return "Invalid ticket key format";
          return true;
        },
      },
    ]);

    const key = ticketKey.toUpperCase();

    const spinner = createStyledSpinner(`Loading ${key}`);
    spinner.start();

    const ticket = await jira.getTicket(key);
    const existingSubtasks = await jira.getSubtasks(key);
    spinner.success({ text: "Ticket loaded" });

    displayTicketDetails(ticket);

    // Show existing subtasks
    if (existingSubtasks.length > 0) {
      console.log();
      console.log(chalk.bold("  📋 Existing Subtasks:"));
      existingSubtasks.forEach((st) => {
        console.log(
          `     ${chalk.yellow(st.key)} - ${st.summary} [${getStatusColor(st.status)(st.status)}]`,
        );
      });
    }

    // Workflow subtask templates
    const workflowOptions = [
      {
        name: "DEV Code Review",
        summary: `DEV Code Review - ${ticket.summary}`,
        description: "Perform code review of the implementation",
      },
      {
        name: "QA Review",
        summary: `QA Review - ${ticket.summary}`,
        description: "QA testing and verification",
      },
      {
        name: "Documentation",
        summary: `Documentation - ${ticket.summary}`,
        description: "Update relevant documentation",
      },
      {
        name: "Deploy to Staging",
        summary: `Deploy to Staging - ${ticket.summary}`,
        description: "Deploy changes to staging environment",
      },
      {
        name: "Deploy to Production",
        summary: `Deploy to Production - ${ticket.summary}`,
        description: "Deploy changes to production environment",
      },
    ];

    const { selectedWorkflows } = await inquirer.prompt<{
      selectedWorkflows: string[];
    }>([
      {
        type: "checkbox",
        name: "selectedWorkflows",
        message: "Select subtasks to create:",
        choices: workflowOptions.map((w) => ({
          name: w.name,
          value: w.name,
          checked: false,
        })),
      },
    ]);

    if (selectedWorkflows.length === 0) {
      showInfo("No subtasks selected");
      return;
    }

    // Optional: Assign to someone
    const { assignToSelf } = await inquirer.prompt<{ assignToSelf: boolean }>([
      {
        type: "confirm",
        name: "assignToSelf",
        message: "Assign these subtasks to yourself?",
        default: false,
      },
    ]);

    const createSpinner = createStyledSpinner("Creating subtasks");
    createSpinner.start();

    let assignee: string | undefined;
    if (assignToSelf) {
      const connection = await jira.verifyConnection();
      assignee = connection.accountId;
    }

    const created: string[] = [];
    for (const workflowName of selectedWorkflows) {
      const template = workflowOptions.find((w) => w.name === workflowName);
      if (!template) continue;

      try {
        const subtask = await jira.createSubtask({
          parentKey: key,
          summary: template.summary,
          description: template.description,
          assigneeAccountId: assignee,
        });
        created.push(subtask.key);
      } catch {
        console.log(chalk.red(`  Failed to create: ${template.name}`));
      }
    }

    createSpinner.success({ text: `Created ${created.length} subtasks` });

    if (created.length > 0) {
      showSuccess(`Created: ${created.join(", ")}`);
    }
  } catch (error) {
    showError(
      "Failed to create workflow subtasks",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Add comment to a ticket
 */
export async function addCommentInteractive(): Promise<void> {
  showBanner();

  try {
    const jira = createJiraClient();

    const { ticketKey, comment } = await inquirer.prompt<{
      ticketKey: string;
      comment: string;
    }>([
      {
        type: "input",
        name: "ticketKey",
        message: "🎫 Ticket key (e.g., PROJ-123):",
        validate: (input: string) => {
          if (!input) return "Ticket key is required";
          if (!/^[A-Z]+-\d+$/i.test(input)) return "Invalid ticket key format";
          return true;
        },
      },
      {
        type: "input",
        name: "comment",
        message: "💬 Comment:",
        validate: (input: string) => input.length > 0 || "Comment is required",
      },
    ]);

    const spinner = createStyledSpinner("Adding comment");
    spinner.start();

    await jira.addComment(ticketKey.toUpperCase(), comment);

    spinner.success({ text: "Comment added!" });
    showSuccess(`Comment added to ${ticketKey.toUpperCase()}`);
  } catch (error) {
    showError(
      "Failed to add comment",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Search tickets by JQL
 */
export async function searchTicketsInteractive(): Promise<void> {
  showBanner();

  try {
    const jira = createJiraClient();

    const { searchType } = await inquirer.prompt<{ searchType: string }>([
      {
        type: "list",
        name: "searchType",
        message: "Search by:",
        choices: [
          { name: "🔤 Text search", value: "text" },
          { name: "📝 Custom JQL", value: "jql" },
          { name: "🏷️  Project", value: "project" },
        ],
      },
    ]);

    let jql: string;

    if (searchType === "text") {
      const { text } = await inquirer.prompt<{ text: string }>([
        {
          type: "input",
          name: "text",
          message: "Search text:",
          validate: (input: string) =>
            input.length > 0 || "Search text is required",
        },
      ]);
      jql = `text ~ "${text}" ORDER BY updated DESC`;
    } else if (searchType === "jql") {
      const { customJql } = await inquirer.prompt<{ customJql: string }>([
        {
          type: "input",
          name: "customJql",
          message: "JQL query:",
          validate: (input: string) => input.length > 0 || "JQL is required",
        },
      ]);
      jql = customJql;
    } else {
      const { project } = await inquirer.prompt<{ project: string }>([
        {
          type: "input",
          name: "project",
          message: "Project key (e.g., PROJ):",
          validate: (input: string) =>
            input.length > 0 || "Project is required",
        },
      ]);
      jql = `project = ${project.toUpperCase()} ORDER BY updated DESC`;
    }

    const spinner = createStyledSpinner("Searching");
    spinner.start();

    const tickets = await jira.searchTickets(jql, 20);
    spinner.success({ text: `Found ${tickets.length} tickets` });

    if (tickets.length === 0) {
      showInfo("No tickets found");
      return;
    }

    displayTicketList(tickets);

    const { selectedKey } = await inquirer.prompt<{ selectedKey: string }>([
      {
        type: "list",
        name: "selectedKey",
        message: "Select a ticket:",
        choices: [
          ...tickets.map((t) => ({
            name: `${chalk.yellow(t.key)} - ${t.summary.slice(0, 50)}... [${getStatusColor(t.status.name)(t.status.name)}]`,
            value: t.key,
          })),
          { name: chalk.gray("← Back"), value: "__back__" },
        ],
      },
    ]);

    if (selectedKey === "__back__") return;

    const ticket = tickets.find((t) => t.key === selectedKey);
    if (ticket) {
      await ticketActionsMenu(ticket);
    }
  } catch (error) {
    showError(
      "Search failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

// ============================================
// Sub-menus
// ============================================

async function ticketActionsMenu(ticket: JiraTicket): Promise<void> {
  displayTicketDetails(ticket);

  const { action } = await inquirer.prompt<{ action: string }>([
    {
      type: "list",
      name: "action",
      message: "What would you like to do?",
      choices: [
        { name: "📍 Move ticket", value: "move" },
        { name: "📋 View subtasks", value: "subtasks" },
        { name: "➕ Create subtask", value: "create-subtask" },
        { name: "💬 Add comment", value: "comment" },
        { name: "🌐 Open in browser", value: "browser" },
        { name: "👋 Back", value: "back" },
      ],
    },
  ]);

  const jira = createJiraClient();

  switch (action) {
    case "move":
      await moveTicketInteractive(ticket.key);
      break;
    case "subtasks": {
      const subtasks = await jira.getSubtasks(ticket.key);
      if (subtasks.length === 0) {
        showInfo("No subtasks");
      } else {
        displaySubtaskList(subtasks);
      }
      break;
    }
    case "create-subtask":
      await createSubtaskInteractive(ticket.key);
      break;
    case "comment": {
      const { comment } = await inquirer.prompt<{ comment: string }>([
        { type: "input", name: "comment", message: "Comment:" },
      ]);
      if (comment) {
        await jira.addComment(ticket.key, comment);
        showSuccess("Comment added!");
      }
      break;
    }
    case "browser": {
      const ticketUrl = `https://${process.env["JIRA_HOST"]}/browse/${ticket.key}`;
      console.log(chalk.cyan(`\n  🌐 ${ticketUrl}\n`));
      break;
    }
  }
}

async function selectAndMoveSubtask(subtasks: JiraSubtask[]): Promise<void> {
  const { key } = await inquirer.prompt<{ key: string }>([
    {
      type: "list",
      name: "key",
      message: "Select subtask to move:",
      choices: subtasks.map((st) => ({
        name: `${chalk.yellow(st.key)} - ${st.summary} [${st.status}]`,
        value: st.key,
      })),
    },
  ]);

  await moveTicketInteractive(key);
}

async function selectAndUpdateSubtask(subtasks: JiraSubtask[]): Promise<void> {
  const jira = createJiraClient();

  const { key } = await inquirer.prompt<{ key: string }>([
    {
      type: "list",
      name: "key",
      message: "Select subtask to update:",
      choices: subtasks.map((st) => ({
        name: `${chalk.yellow(st.key)} - ${st.summary}`,
        value: st.key,
      })),
    },
  ]);

  const { field } = await inquirer.prompt<{ field: string }>([
    {
      type: "list",
      name: "field",
      message: "What to update?",
      choices: [
        { name: "Summary", value: "summary" },
        { name: "Description (append)", value: "description" },
      ],
    },
  ]);

  if (field === "summary") {
    const { summary } = await inquirer.prompt<{ summary: string }>([
      { type: "input", name: "summary", message: "New summary:" },
    ]);
    await jira.updateTicket({ ticketKey: key, summary });
    showSuccess("Summary updated!");
  } else {
    const { text } = await inquirer.prompt<{ text: string }>([
      { type: "input", name: "text", message: "Text to append:" },
    ]);
    // JiraClient doesn't have appendToDescription — inline the read+update
    // the same way the old service did it.
    const existing = await jira.getTicket(key);
    const existingDescription = existing.description || "";
    const newDescription = existingDescription
      ? `${existingDescription}\n\n${text}`
      : text;
    await jira.updateTicket({ ticketKey: key, description: newDescription });
    showSuccess("Description updated!");
  }
}

async function selectAndCommentSubtask(subtasks: JiraSubtask[]): Promise<void> {
  const jira = createJiraClient();

  const { key } = await inquirer.prompt<{ key: string }>([
    {
      type: "list",
      name: "key",
      message: "Select subtask:",
      choices: subtasks.map((st) => ({
        name: `${chalk.yellow(st.key)} - ${st.summary}`,
        value: st.key,
      })),
    },
  ]);

  const { comment } = await inquirer.prompt<{ comment: string }>([
    { type: "input", name: "comment", message: "Comment:" },
  ]);

  if (comment) {
    await jira.addComment(key, comment);
    showSuccess("Comment added!");
  }
}

async function createSubtaskInteractive(parentKey: string): Promise<void> {
  const jira = createJiraClient();

  const { summary, description, assignToSelf } = await inquirer.prompt<{
    summary: string;
    description: string;
    assignToSelf: boolean;
  }>([
    {
      type: "input",
      name: "summary",
      message: "Subtask summary:",
      validate: (input: string) => input.length > 0 || "Summary is required",
    },
    {
      type: "input",
      name: "description",
      message: "Description (optional):",
    },
    {
      type: "confirm",
      name: "assignToSelf",
      message: "Assign to yourself?",
      default: false,
    },
  ]);

  const spinner = createStyledSpinner("Creating subtask");
  spinner.start();

  let assignee: string | undefined;
  if (assignToSelf) {
    const connection = await jira.verifyConnection();
    assignee = connection.accountId;
  }

  const subtask = await jira.createSubtask({
    parentKey,
    summary,
    description: description || undefined,
    assigneeAccountId: assignee,
  });

  spinner.success({ text: `Created ${subtask.key}` });
  showSuccess(`Subtask created: ${subtask.key}`);
}

// ============================================
// Display Helpers
// ============================================

function displayTicketDetails(ticket: JiraTicket): void {
  const statusColor = getStatusColor(ticket.status.name);
  const priorityName = ticket.priority?.name || "None";
  const assigneeName = ticket.assignee?.displayName || "Unassigned";
  // Construct URL from project key
  const ticketUrl = `https://${process.env["JIRA_HOST"]}/browse/${ticket.key}`;

  const content = [
    `${chalk.bold("Key:")} ${chalk.yellow(ticket.key)}`,
    `${chalk.bold("Summary:")} ${ticket.summary}`,
    `${chalk.bold("Status:")} ${statusColor(ticket.status.name)}`,
    `${chalk.bold("Type:")} ${ticket.issueType.name}`,
    `${chalk.bold("Priority:")} ${getPriorityColor(priorityName)(priorityName)}`,
    `${chalk.bold("Assignee:")} ${assigneeName}`,
    "",
    `${chalk.bold("URL:")} ${chalk.underline.blue(ticketUrl)}`,
  ].join("\n");

  showBox(content, {
    title: "🎫 Ticket Details",
    borderColor: "cyan",
  });
}

function displayTicketList(tickets: JiraTicket[]): void {
  console.log();
  console.log(chalk.bold.cyan("  🎫 Tickets"));
  console.log(
    chalk.gray("  ─────────────────────────────────────────────────────────"),
  );

  tickets.forEach((ticket) => {
    const statusName = ticket.status?.name || "Unknown";
    const statusColor = getStatusColor(statusName);
    const priorityName = ticket.priority?.name || "None";
    const priorityIcon = getPriorityIcon(priorityName);
    const ticketKey = ticket.key || "???";
    const summary = ticket.summary || "";

    console.log(
      `  ${priorityIcon} ${chalk.yellow(ticketKey.padEnd(12))} ${statusColor(statusName.padEnd(15))} ${chalk.white(summary.slice(0, 45))}${summary.length > 45 ? "..." : ""}`,
    );
  });

  console.log(
    chalk.gray("  ─────────────────────────────────────────────────────────"),
  );
  console.log();
}

function displaySubtaskList(subtasks: JiraSubtask[]): void {
  console.log();
  console.log(chalk.bold.cyan("  📋 Subtasks"));
  console.log(
    chalk.gray("  ─────────────────────────────────────────────────────────"),
  );

  subtasks.forEach((st) => {
    const statusColor = getStatusColor(st.status);
    console.log(
      `  ${chalk.yellow(st.key.padEnd(12))} ${statusColor(st.status.padEnd(15))} ${chalk.white(st.summary.slice(0, 45))}${st.summary.length > 45 ? "..." : ""}`,
    );
  });

  console.log(
    chalk.gray("  ─────────────────────────────────────────────────────────"),
  );
  console.log();
}

function getStatusColor(status: string): (text: string) => string {
  const s = status.toLowerCase();

  if (s.includes("done") || s.includes("complete") || s.includes("closed")) {
    return chalk.green;
  }
  if (s.includes("progress") || s.includes("review") || s.includes("testing")) {
    return chalk.yellow;
  }
  if (s.includes("blocked") || s.includes("hold")) {
    return chalk.red;
  }
  if (s.includes("todo") || s.includes("open") || s.includes("new")) {
    return chalk.blue;
  }
  return chalk.gray;
}

function getPriorityColor(priority: string): (text: string) => string {
  const p = priority.toLowerCase();

  if (
    p.includes("critical") ||
    p.includes("blocker") ||
    p.includes("highest")
  ) {
    return chalk.red.bold;
  }
  if (p.includes("high")) {
    return chalk.red;
  }
  if (p.includes("medium") || p.includes("normal")) {
    return chalk.yellow;
  }
  if (p.includes("low")) {
    return chalk.green;
  }
  return chalk.gray;
}

function getPriorityIcon(priority: string): string {
  const p = priority.toLowerCase();

  if (
    p.includes("critical") ||
    p.includes("blocker") ||
    p.includes("highest")
  ) {
    return "🔴";
  }
  if (p.includes("high")) {
    return "🟠";
  }
  if (p.includes("medium") || p.includes("normal")) {
    return "🟡";
  }
  if (p.includes("low")) {
    return "🟢";
  }
  return "⚪";
}
