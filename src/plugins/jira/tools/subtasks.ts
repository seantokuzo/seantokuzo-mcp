/**
 * Subtask tools for the jira plugin.
 *
 * Three tools: create a subtask under a parent ticket, list subtasks for a
 * parent, and fetch the authenticated user's code review subtasks.
 */

import { z } from "zod";
import type { ToolDefinition } from "../../types.js";
import { getClient } from "../state.js";

// ============================================================================
// Shared schema fragments
// ============================================================================

const ticketKeyField = z
  .string()
  .min(1)
  .describe("Jira issue key, e.g. 'PROJ-123'");

// ============================================================================
// create_subtask
// ============================================================================

const createSubtaskSchema = z.object({
  parent_key: ticketKeyField,
  summary: z.string().min(1).describe("Subtask summary / title"),
  description: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional plain-text description. Wrapped in a single ADF paragraph — rich formatting is not supported yet.",
    ),
  assignee_account_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Atlassian accountId of the assignee. Leave empty to stay unassigned.",
    ),
});

const createSubtaskTool: ToolDefinition = {
  name: "create_subtask",
  description: `Create a new subtask under a parent Jira ticket.

The subtask inherits the parent's project automatically. The issue type is fixed to "Sub-task" (the standard Jira subtask type). Returns the new subtask's key and metadata.`,
  inputSchema: createSubtaskSchema,
  handler: async (args, _context) => {
    const input = createSubtaskSchema.parse(args);
    const client = getClient();

    const subtask = await client.createSubtask({
      parentKey: input.parent_key,
      summary: input.summary,
      description: input.description,
      assigneeAccountId: input.assignee_account_id,
    });

    return {
      success: true,
      message: `Created subtask ${subtask.key} under ${input.parent_key}`,
      data: subtask,
    };
  },
};

// ============================================================================
// get_subtasks
// ============================================================================

const getSubtasksSchema = z.object({
  ticket_key: ticketKeyField,
});

const getSubtasksTool: ToolDefinition = {
  name: "get_subtasks",
  description:
    "List the subtasks of a Jira ticket. Note: each subtask entry contains key, summary, and status, but NOT assignee (the parent's subtasks field doesn't include it). Call `get_ticket` on a specific subtask if you need full details.",
  inputSchema: getSubtasksSchema,
  handler: async (args, _context) => {
    const input = getSubtasksSchema.parse(args);
    const client = getClient();

    const subtasks = await client.getSubtasks(input.ticket_key);

    return {
      success: true,
      message: `${input.ticket_key} has ${subtasks.length} subtask(s)`,
      data: subtasks,
    };
  },
};

// ============================================================================
// get_my_code_reviews
// ============================================================================

const getMyCodeReviewsSchema = z.object({
  project_key: z
    .string()
    .optional()
    .describe("Optional project key to filter by (e.g. 'PROJ')"),
});

const getMyCodeReviewsTool: ToolDefinition = {
  name: "get_my_code_reviews",
  description: `Get all unresolved "code review" subtasks assigned to the authenticated user.

Matches subtasks whose summary contains the word "review" (case-insensitive). Useful as a one-liner for "what reviews am I on the hook for?".`,
  inputSchema: getMyCodeReviewsSchema,
  handler: async (args, _context) => {
    const input = getMyCodeReviewsSchema.parse(args);
    const client = getClient();

    const reviews = await client.getMyCodeReviews(input.project_key);

    return {
      success: true,
      message: `You have ${reviews.length} open code review(s)${
        input.project_key ? ` in ${input.project_key}` : ""
      }`,
      data: reviews,
    };
  },
};

// ============================================================================
// Export
// ============================================================================

export const subtaskTools: ToolDefinition[] = [
  createSubtaskTool,
  getSubtasksTool,
  getMyCodeReviewsTool,
];
