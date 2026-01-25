/**
 * 🌐 Express Webhook Server
 * Listens for GitHub push events and auto-updates PR descriptions
 */

import express from "express";
import crypto from "crypto";
import { getConfig } from "./utils/config.js";
import { getGitHubService } from "./services/github.js";
import logger from "./utils/logger.js";
import type { WebhookPayload } from "./types/index.js";

const app = express();

// Parse JSON bodies
app.use(express.json());

/**
 * Verify GitHub webhook signature
 */
function verifySignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  if (!secret) {
    logger.warn(
      "WEBHOOK_SECRET not configured - skipping signature verification",
    );
    return true; // Allow in development
  }

  const hmac = crypto.createHmac("sha256", secret);
  const digest = "sha256=" + hmac.update(payload).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Health check endpoint
 */
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "sean-mcp-webhook",
    timestamp: new Date().toISOString(),
  });
});

/**
 * GitHub webhook endpoint
 */
app.post("/webhook/github", async (req, res): Promise<void> => {
  const config = getConfig();
  const signature = req.headers["x-hub-signature-256"] as string;
  const event = req.headers["x-github-event"] as string;
  const deliveryId = req.headers["x-github-delivery"] as string;

  logger.info(`Received GitHub webhook: ${event} (${deliveryId})`);

  // Verify signature
  const rawBody = JSON.stringify(req.body);
  if (!verifySignature(rawBody, signature, config.webhook.secret)) {
    logger.error("Invalid webhook signature");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const payload = req.body as WebhookPayload;

  try {
    switch (event) {
      case "push":
        await handlePushEvent(payload);
        break;
      case "pull_request":
        await handlePullRequestEvent(payload);
        break;
      default:
        logger.debug(`Ignoring event: ${event}`);
    }

    res.json({ status: "processed", event });
  } catch (error) {
    logger.error("Error processing webhook:", error);
    res.status(500).json({
      error: "Processing failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * Handle push events - update PR description if PR exists for branch
 */
async function handlePushEvent(payload: WebhookPayload): Promise<void> {
  if (!payload.repository || !payload.ref) {
    logger.debug("Push event missing required data");
    return;
  }

  // Extract branch name from ref (refs/heads/branch-name)
  const branchMatch = payload.ref.match(/^refs\/heads\/(.+)$/);
  if (!branchMatch) {
    logger.debug("Push was not to a branch");
    return;
  }

  const branchName = branchMatch[1]!;
  const repoOwner = payload.repository.owner.login;
  const repoName = payload.repository.name;

  logger.info(`Push to ${repoOwner}/${repoName}:${branchName}`);

  // Skip main/master branches
  if (branchName === "main" || branchName === "master") {
    logger.debug("Skipping main/master branch");
    return;
  }

  try {
    const github = getGitHubService();
    const repo = { owner: repoOwner, repo: repoName };

    // Find PR for this branch
    const pr = await github.findPRForBranch(repo, branchName);

    if (!pr) {
      logger.debug(`No open PR found for branch ${branchName}`);
      return;
    }

    logger.info(`Found PR #${pr.number} for branch ${branchName}`);

    // Get updated commit info
    const commits = await github.getPRCommits(repo, pr.number);
    const files = await github.getPRFiles(repo, pr.number);

    // Generate updated description
    const body = generateUpdatedDescription({
      existingBody: pr.body || "",
      commits,
      diffStats: {
        additions: files.reduce((sum, f) => sum + f.additions, 0),
        deletions: files.reduce((sum, f) => sum + f.deletions, 0),
        changedFiles: files.length,
      },
      newCommits: payload.commits || [],
    });

    // Update the PR
    await github.updatePullRequest({
      repo,
      pullNumber: pr.number,
      body,
    });

    logger.info(`Updated PR #${pr.number} description`);
  } catch (error) {
    logger.error("Failed to update PR on push:", error);
  }
}

/**
 * Handle pull_request events
 */
async function handlePullRequestEvent(payload: WebhookPayload): Promise<void> {
  if (!payload.action || !payload.pull_request) {
    return;
  }

  logger.info(`PR event: ${payload.action} #${payload.pull_request.number}`);

  // Could add handlers for:
  // - 'opened': Add default labels, reviewers
  // - 'synchronize': Already handled by push events
  // - 'review_requested': Notifications
}

/**
 * Generate updated PR description after push
 */
function generateUpdatedDescription(context: {
  existingBody: string;
  commits: Array<{ message: string; sha: string }>;
  diffStats: { additions: number; deletions: number; changedFiles: number };
  newCommits: Array<{ id: string; message: string }>;
}): string {
  const { existingBody, commits, diffStats, newCommits } = context;

  // Try to update the existing sections
  let body = existingBody;

  // Update stats section
  const statsRegex = /## 📊 Changes[\s\S]*?(?=##|---|\n\n\n|$)/;
  const newStats = [
    "## 📊 Changes",
    `- **Files changed:** ${diffStats.changedFiles}`,
    `- **Additions:** +${diffStats.additions}`,
    `- **Deletions:** -${diffStats.deletions}`,
    "",
  ].join("\n");

  if (statsRegex.test(body)) {
    body = body.replace(statsRegex, newStats);
  }

  // Update commits section
  const commitsRegex = /## 📝 Commits[\s\S]*?(?=##|---|\n\n\n|$)/;
  const newCommitsSection = [
    "## 📝 Commits",
    ...commits
      .slice(0, 10)
      .map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.message.split("\n")[0]}`),
    commits.length > 10 ? `- ... and ${commits.length - 10} more commits` : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");

  if (commitsRegex.test(body)) {
    body = body.replace(commitsRegex, newCommitsSection);
  }

  // Add update note if there were new commits
  if (newCommits.length > 0) {
    const updateNote = `\n\n> 🔄 **Auto-updated** with ${newCommits.length} new commit(s) on ${new Date().toLocaleDateString()}\n`;

    // Add before footer if exists, otherwise at end
    const footerIndex = body.indexOf("---\n*Generated by");
    if (footerIndex > -1) {
      body = body.slice(0, footerIndex) + updateNote + body.slice(footerIndex);
    } else {
      body += updateNote;
    }
  }

  return body;
}

/**
 * Start the webhook server
 */
export function startWebhookServer(): void {
  const config = getConfig();
  const port = config.webhook.port;

  app.listen(port, () => {
    logger.info(`🌐 Webhook server running on port ${port}`);
    logger.info(
      `📍 GitHub webhook URL: http://localhost:${port}/webhook/github`,
    );
    logger.info(`❤️  Health check: http://localhost:${port}/health`);

    if (!config.webhook.secret) {
      logger.warn(
        "⚠️  WEBHOOK_SECRET not set - signature verification disabled",
      );
    }
  });
}

// Run if executed directly
if (
  process.argv[1]?.endsWith("server.ts") ||
  process.argv[1]?.endsWith("server.js")
) {
  startWebhookServer();
}

export default app;
