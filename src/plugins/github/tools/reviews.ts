/**
 * PR review tools for the github plugin.
 *
 * Four tools: fetching reviews and review comments, submitting a full review
 * (approve/request-changes/comment), and adding a single line comment.
 */

import { z } from "zod";
import { defineTool, type ToolDefinition } from "../../types.js";
import { getClient } from "../state.js";
import { resolveRepository } from "../shared.js";

// ============================================================================
// Shared schema fragments
// ============================================================================

const repositoryField = z
  .string()
  .optional()
  .describe(
    "Repository as owner/repo, full GitHub URL, or just the repo name if GITHUB_USERNAME is set. Auto-detected from the current git repo if omitted.",
  );

const pullNumberField = z
  .number()
  .int()
  .min(1)
  .describe("The pull request number to target");

// ============================================================================
// get_pr_reviews
// ============================================================================

const getPRReviewsSchema = z.object({
  repository: repositoryField,
  pull_number: pullNumberField,
});

const getPRReviewsTool = defineTool({
  name: "get_pr_reviews",
  description:
    "Get all reviews submitted for a pull request (approvals, change requests, comments).",
  inputSchema: getPRReviewsSchema,
  handler: async (input, context) => {
    const client = getClient();

    const { repo } = await resolveRepository(
      context,
      input.repository,
      client.defaultOwner,
    );

    const reviews = await client.getPRReviews(repo, input.pull_number);

    return {
      success: true,
      message: `Found ${reviews.length} review(s) on PR #${input.pull_number}`,
      data: reviews,
    };
  },
});

// ============================================================================
// get_pr_review_comments
// ============================================================================

const getPRReviewCommentsTool = defineTool({
  name: "get_pr_review_comments",
  description:
    "Get all line-level review comments on a pull request (inline comments tied to specific files and lines).",
  inputSchema: getPRReviewsSchema,
  handler: async (input, context) => {
    const client = getClient();

    const { repo } = await resolveRepository(
      context,
      input.repository,
      client.defaultOwner,
    );

    const comments = await client.getPRReviewComments(repo, input.pull_number);

    return {
      success: true,
      message: `Found ${comments.length} review comment(s) on PR #${input.pull_number}`,
      data: comments,
    };
  },
});

// ============================================================================
// submit_review
// ============================================================================

const reviewCommentSchema = z.object({
  path: z.string().describe("File path in the repository"),
  line: z
    .number()
    .int()
    .min(1)
    .describe("Line number in the file to comment on"),
  body: z.string().describe("Comment text"),
  side: z
    .enum(["LEFT", "RIGHT"])
    .optional()
    .default("RIGHT")
    .describe(
      "Which side of the diff (LEFT = base/original, RIGHT = head/updated). Default: RIGHT.",
    ),
});

const submitReviewSchema = z.object({
  repository: repositoryField,
  pull_number: pullNumberField,
  body: z.string().describe("Overall review summary / body text"),
  event: z
    .enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"])
    .describe(
      "The review action. APPROVE = approve, REQUEST_CHANGES = block merge, COMMENT = comment without approving.",
    ),
  comments: z
    .array(reviewCommentSchema)
    .optional()
    .describe("Optional inline comments to submit as part of this review"),
});

const submitReviewTool = defineTool({
  name: "submit_review",
  description: `Submit a complete review on a pull request with an overall verdict (APPROVE, REQUEST_CHANGES, or COMMENT) and optional inline comments.

Use this when performing a full code review. For single ad-hoc comments, use \`add_review_comment\` instead.`,
  inputSchema: submitReviewSchema,
  handler: async (input, context) => {
    const client = getClient();

    const { repo } = await resolveRepository(
      context,
      input.repository,
      client.defaultOwner,
    );

    const review = await client.submitReview({
      repo,
      pullNumber: input.pull_number,
      body: input.body,
      event: input.event,
      comments: input.comments,
    });

    return {
      success: true,
      message: `Submitted ${input.event} review on PR #${input.pull_number}`,
      data: review,
    };
  },
});

// ============================================================================
// add_review_comment
// ============================================================================

const addReviewCommentSchema = z.object({
  repository: repositoryField,
  pull_number: pullNumberField,
  body: z.string().describe("Comment body"),
  path: z.string().describe("File path in the repository"),
  line: z.number().int().min(1).describe("Line number to comment on"),
  commit_id: z
    .string()
    .describe(
      "SHA of the commit to attach the comment to. Usually the HEAD SHA of the PR — fetch via `get_pull_request`.",
    ),
  side: z
    .enum(["LEFT", "RIGHT"])
    .optional()
    .default("RIGHT")
    .describe(
      "Which side of the diff (LEFT = base/original, RIGHT = head/updated). Default: RIGHT.",
    ),
});

const addReviewCommentTool = defineTool({
  name: "add_review_comment",
  description:
    "Add a single inline review comment to a specific line in a pull request. Useful for quick feedback without submitting a full review.",
  inputSchema: addReviewCommentSchema,
  handler: async (input, context) => {
    const client = getClient();

    const { repo } = await resolveRepository(
      context,
      input.repository,
      client.defaultOwner,
    );

    const comment = await client.addReviewComment(
      repo,
      input.pull_number,
      input.body,
      input.path,
      input.line,
      input.commit_id,
      input.side,
    );

    return {
      success: true,
      message: `Added review comment to PR #${input.pull_number} at ${input.path}:${input.line}`,
      data: comment,
    };
  },
});

// ============================================================================
// Export
// ============================================================================

export const reviewTools: ToolDefinition[] = [
  getPRReviewsTool,
  getPRReviewCommentsTool,
  submitReviewTool,
  addReviewCommentTool,
];
