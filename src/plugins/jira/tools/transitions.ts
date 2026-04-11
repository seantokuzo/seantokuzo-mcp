/**
 * Workflow transition tools for the jira plugin.
 *
 * Two tools: list available transitions for a ticket, and move a ticket to a
 * new status by name (high-level, resolves the transition ID automatically).
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
// get_transitions
// ============================================================================

const getTransitionsSchema = z.object({
  ticket_key: ticketKeyField,
});

const getTransitionsTool: ToolDefinition = {
  name: "get_transitions",
  description:
    "List the workflow transitions currently available for a Jira ticket. Each transition has a name (e.g. 'Start Progress') and a target status (e.g. 'In Progress'). Use `move_ticket` to actually apply one.",
  inputSchema: getTransitionsSchema,
  handler: async (args, _context) => {
    const input = getTransitionsSchema.parse(args);
    const client = getClient();

    const transitions = await client.getTransitions(input.ticket_key);

    return {
      success: true,
      message: `${transitions.length} transition(s) available for ${input.ticket_key}`,
      data: transitions,
    };
  },
};

// ============================================================================
// move_ticket
// ============================================================================

const moveTicketSchema = z.object({
  ticket_key: ticketKeyField,
  status: z
    .string()
    .min(1)
    .describe(
      "Target status or transition name (case-insensitive). Matches either the transition name ('Start Progress') or the destination status name ('In Progress').",
    ),
  comment: z
    .string()
    .optional()
    .describe("Optional plain-text comment to post with the transition"),
});

const moveTicketTool: ToolDefinition = {
  name: "move_ticket",
  description: `Move a Jira ticket to a new status by name.

Looks up the available transitions and picks the one whose name or target status matches (case-insensitive). Throws a descriptive error listing available transitions if no match is found. Use \`get_transitions\` first if you need to see options.`,
  inputSchema: moveTicketSchema,
  handler: async (args, _context) => {
    const input = moveTicketSchema.parse(args);
    const client = getClient();

    const transition = await client.moveTicket(
      input.ticket_key,
      input.status,
      input.comment,
    );

    return {
      success: true,
      message: `Moved ${input.ticket_key} via "${transition.name}" → ${transition.to.name}`,
      data: {
        ticket_key: input.ticket_key,
        transition: {
          id: transition.id,
          name: transition.name,
          to_status: transition.to.name,
          to_category: transition.to.category,
        },
        comment_added: input.comment !== undefined,
      },
    };
  },
};

// ============================================================================
// Export
// ============================================================================

export const transitionTools: ToolDefinition[] = [
  getTransitionsTool,
  moveTicketTool,
];
