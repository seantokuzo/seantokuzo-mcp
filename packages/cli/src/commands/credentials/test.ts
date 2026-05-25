/**
 * `kuzo credentials test <name>` (spec §B.9). Verify a stored credential is
 * accepted by its service. First-party plugins probe a cheap endpoint
 * (GitHub `/user`, Jira `/myself`); third-party plugins would use the optional
 * `KuzoPluginV2.testCredential` hook.
 *
 * Exit 0 valid, 78 invalid, 79 no-test-available, generic non-zero on transport.
 * Read-only: no lock. The credential read may trigger one keychain prompt.
 *
 * Third-party note: invoking `testCredential` requires constructing the broker
 * (which transitively imports the first-party plugin clients) in the CLI for a
 * path no current plugin exercises — that's deferred until a third-party plugin
 * shipping the hook exists. The hook contract is already on `KuzoPluginV2`.
 */

import chalk from "chalk";

import type { AuditLogger } from "@kuzo-mcp/core/audit";
import { FIRST_PARTY_ENV_RESERVATIONS } from "@kuzo-mcp/core/credentials";

import { CredentialsCliError } from "./errors.js";
import { openSource } from "./store-access.js";
import { firstPartyServiceForEnv, thirdPartyOwnerForEnv } from "./targets.js";

export async function runTest(name: string): Promise<void> {
  const service = firstPartyServiceForEnv(name);
  if (service === "github") return testGithub(name);
  if (service === "jira") return testJira(name);

  const owner = thirdPartyOwnerForEnv(name);
  if (owner) {
    throw new CredentialsCliError(
      "E_TEST_UNAVAILABLE",
      `${name} is declared by ${owner} (third-party). Validity testing via the optional ` +
        `KuzoPluginV2.testCredential hook is not wired in this build — try a tool call to confirm runtime behavior.`,
    );
  }
  throw new CredentialsCliError(
    "E_TEST_UNAVAILABLE",
    `No installed plugin declares credential "${name}", so there's no service to test it against.`,
  );
}

async function testGithub(name: string): Promise<void> {
  const { source, audit } = openSource(new Set(FIRST_PARTY_ENV_RESERVATIONS["@kuzo-mcp/plugin-github"]));
  const token = source.get("GITHUB_TOKEN");
  if (!token) {
    throw new CredentialsCliError(
      "E_TEST_UNAVAILABLE",
      `${name} — presence verified: no. Set it first: kuzo credentials set GITHUB_TOKEN`,
    );
  }

  let res: Response;
  try {
    res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "kuzo-mcp",
      },
    });
  } catch (err) {
    throw new Error(`${name} — ${describeNetworkError(err)}`, { cause: err });
  }

  if (res.ok) {
    const login = await readJsonField(res, "login");
    auditTested(audit, name, "github", "valid", res.status);
    console.log(chalk.green(`✓ ${name} — authenticated${login ? ` as ${login}` : ""}`));
    return;
  }
  auditTested(audit, name, "github", "invalid", res.status);
  throw new CredentialsCliError("E_CRED_INVALID", `${name} — HTTP ${res.status} ${httpMeaning(res.status)}`);
}

async function testJira(name: string): Promise<void> {
  const { source, audit } = openSource(new Set(FIRST_PARTY_ENV_RESERVATIONS["@kuzo-mcp/plugin-jira"]));
  const host = source.get("JIRA_HOST");
  const email = source.get("JIRA_EMAIL");
  const token = source.get("JIRA_API_TOKEN");

  const missing = (
    [
      ["JIRA_HOST", host],
      ["JIRA_EMAIL", email],
      ["JIRA_API_TOKEN", token],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new CredentialsCliError(
      "E_TEST_UNAVAILABLE",
      `Cannot test ${name} — Jira authentication needs ${missing.join(", ")} set. Run: kuzo credentials set <NAME>`,
    );
  }

  const base = host!.startsWith("http") ? host! : `https://${host!}`;
  const url = `${base.replace(/\/+$/, "")}/rest/api/3/myself`;
  const authz = "Basic " + Buffer.from(`${email!}:${token!}`).toString("base64");

  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: authz, Accept: "application/json" } });
  } catch (err) {
    throw new Error(`${name} — ${describeNetworkError(err)}`, { cause: err });
  }

  if (res.ok) {
    const who = (await readJsonField(res, "displayName")) ?? (await readJsonField(res, "emailAddress"));
    auditTested(audit, name, "jira", "valid", res.status);
    console.log(chalk.green(`✓ ${name} — authenticated${who ? ` as ${who}` : ""}`));
    return;
  }
  auditTested(audit, name, "jira", "invalid", res.status);
  throw new CredentialsCliError("E_CRED_INVALID", `${name} — HTTP ${res.status} ${httpMeaning(res.status)}`);
}

function auditTested(
  audit: AuditLogger,
  credentialKey: string,
  plugin: string,
  outcome: "valid" | "invalid",
  httpStatus: number,
): void {
  audit.log({
    plugin: "kuzo",
    action: "credential.tested",
    outcome: outcome === "valid" ? "allowed" : "denied",
    details: { credentialKey, plugin, outcome, http_status: httpStatus },
  });
}

async function readJsonField(res: Response, field: string): Promise<string | undefined> {
  try {
    const body = (await res.clone().json()) as Record<string, unknown>;
    const value = body[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function httpMeaning(status: number): string {
  switch (status) {
    case 401:
      return "unauthorized (token may be expired or revoked)";
    case 403:
      return "forbidden (token lacks the required scope)";
    case 404:
      return "not found (check the host / URL)";
    default:
      return "rejected by the service";
  }
}

function describeNetworkError(err: unknown): string {
  const code = (err as { cause?: { code?: string } }).cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "DNS resolution failed (network problem)";
  if (code === "ECONNREFUSED") return "connection refused (network problem)";
  if (code === "ETIMEDOUT") return "connection timed out (network problem)";
  return `request failed (${(err as Error).message})`;
}
