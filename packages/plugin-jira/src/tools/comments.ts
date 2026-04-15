/**
 * Comment tools for the jira plugin.
 *
 * Two tools: post a comment on a ticket, and list existing comments. ADF
 * extraction to plain text happens inside the client.
 */

import { z } from "zod";
import { defineTool, type ToolDefinition } from "@kuzo-mcp/types";
import { getClient } from "../state.js";

// ============================================================================
// Shared schema fragments
// ============================================================================

const ticketKeyField = z
  .string()
  .min(1)
  .describe("Jira issue key, e.g. 'PROJ-123'");

// ============================================================================
// add_comment
// ============================================================================

const addCommentSchema = z.object({
  ticket_key: ticketKeyField,
  body: z
    .string()
    .min(1)
    .describe(
      "Comment text (plain text). Wrapped in a single ADF paragraph — rich formatting is not supported yet.",
    ),
});

const addCommentTool = defineTool({
  name: "add_comment",
  description:
    "Post a plain-text comment on a Jira ticket. Returns the new comment's id and author metadata.",
  inputSchema: addCommentSchema,
  handler: async (input, _context) => {
    const client = getClient();

    const comment = await client.addComment(input.ticket_key, input.body);

    return {
      success: true,
      message: `Added comment to ${input.ticket_key}`,
      data: comment,
    };
  },
});

// ============================================================================
// get_comments
// ============================================================================

const getCommentsSchema = z.object({
  ticket_key: ticketKeyField,
});

const getCommentsTool = defineTool({
  name: "get_comments",
  description:
    "List all comments on a Jira ticket. Comment bodies are converted from ADF (Atlassian Document Format) to plain text — rich formatting, attachments, and mentions may be flattened.",
  inputSchema: getCommentsSchema,
  handler: async (input, _context) => {
    const client = getClient();

    const comments = await client.getComments(input.ticket_key);

    return {
      success: true,
      message: `${input.ticket_key} has ${comments.length} comment(s)`,
      data: comments,
    };
  },
});

// ============================================================================
// Export
// ============================================================================

export const commentTools: ToolDefinition[] = [addCommentTool, getCommentsTool];
