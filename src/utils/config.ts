/**
 * 🔧 Configuration utilities
 */

import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { existsSync } from "fs";
import type { Personality } from "../types/index.js";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Try to load .env from project root
const envPath = resolve(__dirname, "../../.env");
if (existsSync(envPath)) {
  dotenvConfig({ path: envPath });
} else {
  // Try current working directory
  dotenvConfig();
}

export interface Config {
  github: {
    token: string;
    username: string;
    org: string;
  };
  jira: {
    host: string;
    email: string;
    apiToken: string;
  };
  webhook: {
    port: number;
    secret: string;
  };
  cli: {
    personality: Personality;
  };
  defaults: {
    baseBranch: string;
    draft: boolean;
  };
}

export function getConfig(): Config {
  const personality = (process.env["CLI_PERSONALITY"] ||
    "chaotic") as Personality;

  return {
    github: {
      token: process.env["GITHUB_TOKEN"] || "",
      username: process.env["GITHUB_USERNAME"] || "",
      org: process.env["GITHUB_ORG"] || "",
    },
    jira: {
      host: process.env["JIRA_HOST"] || "",
      email: process.env["JIRA_EMAIL"] || "",
      apiToken: process.env["JIRA_API_TOKEN"] || "",
    },
    webhook: {
      port: parseInt(process.env["WEBHOOK_PORT"] || "3847", 10),
      secret: process.env["WEBHOOK_SECRET"] || "",
    },
    cli: {
      personality: ["professional", "chaotic", "zen"].includes(personality)
        ? personality
        : "chaotic",
    },
    defaults: {
      baseBranch: process.env["DEFAULT_PR_BASE_BRANCH"] || "main",
      draft: process.env["DEFAULT_PR_DRAFT"] === "true",
    },
  };
}

export function validateConfig(config: Config): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.github.token) {
    errors.push(
      "GITHUB_TOKEN is required. Get one at https://github.com/settings/tokens",
    );
  }

  if (!config.github.username) {
    errors.push(
      "GITHUB_USERNAME is required for default author identification",
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateJiraConfig(config: Config): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.jira.host) {
    errors.push("JIRA_HOST is required (e.g., mycompany.atlassian.net)");
  }

  if (!config.jira.email) {
    errors.push("JIRA_EMAIL is required for authentication");
  }

  if (!config.jira.apiToken) {
    errors.push(
      "JIRA_API_TOKEN is required. Get one at https://id.atlassian.com/manage-profile/security/api-tokens",
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function isConfigured(): boolean {
  const config = getConfig();
  return !!config.github.token && !!config.github.username;
}

export function isJiraConfigured(): boolean {
  const config = getConfig();
  return !!config.jira.host && !!config.jira.email && !!config.jira.apiToken;
}
