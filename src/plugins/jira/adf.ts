/**
 * Atlassian Document Format (ADF) helpers.
 *
 * ADF is a nested JSON structure Jira uses for rich-text fields like ticket
 * descriptions and comments. For our purposes we only need two conversions:
 * extract plain text from an ADF tree, and wrap plain text in a minimal ADF
 * paragraph doc for writes.
 *
 * Rich-text authoring (headings, lists, code blocks, etc.) is deliberately
 * out of scope for Phase 2.c. Extend this file if a later phase needs it.
 */

/** Opaque ADF node — we intentionally don't type every variant. */
export interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  [key: string]: unknown;
}

/**
 * Extract plain text from an ADF document.
 *
 * Returns an empty string for null/undefined/non-ADF input. Ported from the
 * legacy `JiraService.extractTextFromADF`.
 */
export function extractTextFromADF(adf: unknown): string {
  if (adf === null || adf === undefined) return "";
  if (typeof adf === "string") return adf;
  if (typeof adf !== "object") return "";

  const node = adf as AdfNode;

  if (node.type === "text") return node.text ?? "";

  if (Array.isArray(node.content)) {
    return node.content.map((child) => extractTextFromADF(child)).join("");
  }

  return "";
}

/**
 * Wrap plain text in a minimal ADF doc (single paragraph).
 *
 * Used when writing descriptions and comments to the Jira API.
 */
export function textToADF(text: string): AdfNode {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}
