/**
 * Ticket tools for the jira plugin.
 *
 * Four tools covering the core ticket lifecycle: fetch by key, JQL search,
 * "assigned to me" shortcut, and field updates.
 */

import { z } from "zod";
import { defineTool, type ToolDefinition } from "../../types.js";
import { getClient } from "../state.js";

// ============================================================================
// Shared schema fragments
// ============================================================================

const ticketKeyField = z
  .string()
  .min(1)
  .describe("Jira issue key, e.g. 'PROJ-123'");

// ============================================================================
// get_ticket
// ============================================================================

const getTicketSchema = z.object({
  ticket_key: ticketKeyField,
});

const getTicketTool = defineTool({
  name: "get_ticket",
  description:
    "Fetch a Jira ticket by key (e.g. 'PROJ-123'). Returns summary, description, status, assignee, labels, subtasks, and metadata.",
  inputSchema: getTicketSchema,
  handler: async (input, _context) => {
    const client = getClient();

    const ticket = await client.getTicket(input.ticket_key);

    return {
      success: true,
      data: ticket,
    };
  },
});

// ============================================================================
// search_tickets
// ============================================================================

const searchTicketsSchema = z.object({
  jql: z
    .string()
    .min(1)
    .describe(
      "JQL query string. Examples: 'project = PROJ AND status = \"In Progress\"', 'assignee = currentUser() AND resolution = Unresolved'",
    ),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(50)
    .describe("Maximum number of tickets to return (1-100, default 50)"),
});

const searchTicketsTool = defineTool({
  name: "search_tickets",
  description: `Search Jira tickets using JQL (Jira Query Language).

TIP: Use \`get_my_tickets\` for the common "assigned to me" case instead of writing JQL by hand.`,
  inputSchema: searchTicketsSchema,
  handler: async (input, _context) => {
    const client = getClient();

    const tickets = await client.searchTickets(input.jql, input.max_results);

    return {
      success: true,
      message: `Found ${tickets.length} ticket(s)`,
      data: tickets,
    };
  },
});

// ============================================================================
// get_my_tickets
// ============================================================================

const getMyTicketsSchema = z.object({
  project_key: z
    .string()
    .optional()
    .describe("Optional project key to filter by (e.g. 'PROJ')"),
});

const getMyTicketsTool = defineTool({
  name: "get_my_tickets",
  description:
    "Get all unresolved Jira tickets assigned to the authenticated user, sorted by most recently updated. Optionally filter by project key.",
  inputSchema: getMyTicketsSchema,
  handler: async (input, _context) => {
    const client = getClient();

    const tickets = await client.getMyTickets(input.project_key);

    return {
      success: true,
      message: `You have ${tickets.length} open ticket(s)${
        input.project_key ? ` in ${input.project_key}` : ""
      }`,
      data: tickets,
    };
  },
});

// ============================================================================
// update_ticket
// ============================================================================

const updateTicketSchema = z
  .object({
    ticket_key: ticketKeyField,
    summary: z
      .string()
      .min(1)
      .optional()
      .describe("New ticket summary / title"),
    description: z
      .string()
      .min(1)
      .optional()
      .describe(
        "New description (plain text). Wrapped in a single ADF paragraph — rich formatting is not supported yet.",
      ),
    labels: z
      .array(z.string())
      .optional()
      .describe(
        "Full replacement list of labels. Pass an empty array to clear all labels.",
      ),
    assignee_account_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Atlassian accountId of the new assignee. Use Jira's people picker to find account IDs.",
      ),
  })
  .refine(
    (data) =>
      data.summary !== undefined ||
      data.description !== undefined ||
      data.labels !== undefined ||
      data.assignee_account_id !== undefined,
    {
      message:
        "At least one of summary, description, labels, or assignee_account_id must be provided",
    },
  );

const updateTicketTool = defineTool({
  name: "update_ticket",
  description: `Update fields on a Jira ticket (summary, description, labels, assignee).

All parameters except \`ticket_key\` are optional, but at least one update field must be provided. String fields (summary, description, assignee_account_id) must be non-empty — to clear one of those, use the Jira UI. To clear every label on a ticket, pass \`labels: []\`.`,
  inputSchema: updateTicketSchema,
  handler: async (input, _context) => {
    const client = getClient();

    await client.updateTicket({
      ticketKey: input.ticket_key,
      summary: input.summary,
      description: input.description,
      labels: input.labels,
      assigneeAccountId: input.assignee_account_id,
    });

    return {
      success: true,
      message: `Updated ticket ${input.ticket_key}`,
      data: {
        ticket_key: input.ticket_key,
        updated_fields: {
          summary: input.summary !== undefined,
          description: input.description !== undefined,
          labels: input.labels !== undefined,
          assignee: input.assignee_account_id !== undefined,
        },
      },
    };
  },
});

// ============================================================================
// Export
// ============================================================================

export const ticketTools: ToolDefinition[] = [
  getTicketTool,
  searchTicketsTool,
  getMyTicketsTool,
  updateTicketTool,
];
