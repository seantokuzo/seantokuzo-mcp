#!/usr/bin/env node
/**
 * Dev-to-install parity test (Phase 2.5e §A.8).
 *
 * Proves that every plugin works identically whether resolved via pnpm
 * workspace symlinks (dev mode) or via `npm install <tarball>` into
 * `$KUZO_PLUGINS_DIR/<name>/node_modules/<pkg>/` (installed mode). This is the
 * only gate that catches silent dual-mode resolution breakage: missing files
 * from the `files` allowlist, broken `exports` subpaths, peer-dep resolution
 * failures, shebang/file-mode regressions.
 *
 * Flow:
 *   1. Build the monorepo.
 *   2. Pack @kuzo-mcp/types + each plugin → tarballs in a temp dir.
 *   3. For each plugin: mkdir $TMPDIR/<name>/, `npm install` the plugin
 *      tarball + types tarball → satisfies the peerDependency on types.
 *   4. Boot `packages/core/dist/server.js` with KUZO_PLUGINS_DIR pointing at
 *      the temp dir, a tmp HOME (isolates ~/.kuzo/audit.log), KUZO_TRUST_ALL
 *      (bypasses consent prompts), and fake creds for github/jira (enough to
 *      pass config validation; children never spawn so creds never hit APIs).
 *   5. MCP handshake + tools/list → assert tools from all 3 plugins present.
 *   6. tools/call get_git_context (no creds needed) → expect success.
 *   7. Read the isolated audit.log → assert plugin.loaded for all three.
 *
 * No github/jira tool calls are made. The parity test validates the
 * install/resolve path, not plugin API connectivity — that belongs in
 * plugin-level tests once a test runner is in place.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const PLUGINS = [
  { name: "git-context", pkg: "@kuzo-mcp/plugin-git-context" },
  { name: "github",      pkg: "@kuzo-mcp/plugin-github" },
  { name: "jira",        pkg: "@kuzo-mcp/plugin-jira" },
];

const EXPECTED_TOOLS = {
  "git-context": "get_git_context",
  "github": "get_repo_info",
  "jira": "get_ticket",
};

const TOOL_CALLS = [
  { name: "get_git_context", arguments: {} },
];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function log(msg) { console.log(`[parity] ${msg}`); }
function fail(msg) { console.error(`[parity] FAIL: ${msg}`); process.exit(1); }


function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });
}

// ---------------------------------------------------------------------------
// Phase 1: Build + pack
// ---------------------------------------------------------------------------

function buildAndPack(tarballDir) {
  log("building monorepo...");
  run("pnpm", ["-s", "run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });

  mkdirSync(tarballDir, { recursive: true });

  const tarballs = {};
  const packTargets = [
    { key: "types", filter: "@kuzo-mcp/types" },
    ...PLUGINS.map((p) => ({ key: p.name, filter: p.pkg })),
  ];

  for (const { key, filter } of packTargets) {
    log(`packing ${filter}...`);
    run("pnpm", ["--filter", filter, "pack", "--pack-destination", tarballDir], { cwd: REPO_ROOT });
    // pnpm pack emits "kuzo-mcp-<name>-<version>.tgz"
    const flat = filter.replace(/^@/, "").replace(/\//, "-");
    const files = readdirSync(tarballDir).filter((f) => f.startsWith(flat) && f.endsWith(".tgz"));
    if (files.length !== 1) fail(`expected 1 tarball for ${filter}, found ${files.length}: ${files.join(", ")}`);
    tarballs[key] = join(tarballDir, files[0]);
  }
  return tarballs;
}

// ---------------------------------------------------------------------------
// Phase 2: Install tarballs into temp plugin dirs
// ---------------------------------------------------------------------------

function installPlugins(pluginsDir, tarballs) {
  for (const { name } of PLUGINS) {
    const dir = join(pluginsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `kuzo-parity-${name}`, version: "0.0.0", private: true }, null, 2));
    log(`npm installing ${name} + types tarballs into ${dir}`);
    run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", tarballs[name], tarballs.types], { cwd: dir, stdio: "inherit" });
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Boot server + MCP handshake
// ---------------------------------------------------------------------------

function bootServer(env) {
  const serverPath = join(REPO_ROOT, "packages", "core", "dist", "server.js");
  if (!existsSync(serverPath)) fail(`server build missing: ${serverPath}`);
  log(`spawning server: node ${serverPath}`);
  const child = spawn("node", [serverPath], {
    cwd: REPO_ROOT,
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });

  let buffer = "";
  const pending = new Map();

  function settle(id, fn, value) {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry[fn](value);
  }

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) settle(msg.id, "resolve", msg);
    }
  });
  child.on("exit", (code) => {
    for (const id of [...pending.keys()]) {
      settle(id, "reject", new Error(`server exited with code ${code} before responding`));
    }
  });

  let nextId = 1;
  function request(method, params) {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(id, "reject", new Error(`timeout waiting for response to ${method} (id=${id})`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify(payload) + "\n");
    });
  }
  function notify(method, params) {
    const payload = { jsonrpc: "2.0", method, params };
    child.stdin.write(JSON.stringify(payload) + "\n");
  }
  async function close() {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  return { request, notify, close };
}

// ---------------------------------------------------------------------------
// Phase 4: Assertions
// ---------------------------------------------------------------------------

function readAuditLog(home) {
  const path = join(home, ".kuzo", "audit.log");
  if (!existsSync(path)) fail(`audit log not created at ${path}`);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function assertToolResult(method, response) {
  if (response.error) fail(`${method} → RPC error: ${JSON.stringify(response.error)}`);
  const content = response.result?.content;
  if (!Array.isArray(content) || content.length === 0) {
    fail(`${method} → malformed result (no content): ${JSON.stringify(response.result)}`);
  }
  if (response.result.isError) {
    const text = content.map((c) => c.text ?? "").join("\n");
    fail(`${method} → tool returned error: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const root = join(tmpdir(), `kuzo-parity-${Date.now()}`);
  const tarballDir = join(root, "tarballs");
  const pluginsDir = join(root, "plugins");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  log(`workdir: ${root}`);

  let server;
  let exitCode = 0;
  try {
    const tarballs = buildAndPack(tarballDir);
    installPlugins(pluginsDir, tarballs);

    // Fake credentials for github + jira so the plugins pass config
    // validation and register in the parent (proxy + tools/list).
    // No tool calls are made against these plugins — plugin.loaded fires
    // at manifest import (lazy spawn), so fake creds never hit an API.
    // Only get_git_context is actually invoked (no creds needed).
    server = bootServer({
      PATH: process.env.PATH,
      HOME: home,
      NODE_ENV: "production",
      KUZO_PLUGINS_DIR: pluginsDir,
      KUZO_TRUST_ALL: "true",
      GITHUB_TOKEN: "parity-fake-token",
      GITHUB_USERNAME: "parity-test",
      JIRA_HOST: "parity-test.atlassian.net",
      JIRA_EMAIL: "parity@example.com",
      JIRA_API_TOKEN: "parity-fake-token",
    });

    log("MCP: initialize");
    const init = await server.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "parity-test", version: "0.0.1" },
    });
    if (init.error) fail(`initialize → ${JSON.stringify(init.error)}`);
    server.notify("notifications/initialized", {});

    log("MCP: tools/list");
    const list = await server.request("tools/list", {});
    if (list.error) fail(`tools/list → ${JSON.stringify(list.error)}`);
    const toolNames = new Set((list.result?.tools ?? []).map((t) => t.name));
    log(`server exposed ${toolNames.size} tools`);
    for (const [plugin, tool] of Object.entries(EXPECTED_TOOLS)) {
      if (!toolNames.has(tool)) fail(`plugin "${plugin}" did not contribute tool "${tool}" to tools/list`);
      log(`  ✓ ${plugin} → ${tool}`);
    }

    for (const call of TOOL_CALLS) {
      log(`MCP: tools/call ${call.name}`);
      const res = await server.request("tools/call", call);
      assertToolResult(call.name, res);
      log(`  ✓ ${call.name} succeeded`);
    }
  } catch (err) {
    console.error(`[parity] ERROR: ${err.message}`);
    exitCode = 1;
  } finally {
    if (server) await server.close().catch(() => {});
  }

  if (exitCode === 0) {
    const events = readAuditLog(home);
    const loaded = new Set(events.filter((e) => e.action === "plugin.loaded").map((e) => e.plugin));
    for (const { name } of PLUGINS) {
      if (!loaded.has(name)) {
        const failures = events.filter((e) => e.plugin === name);
        fail(`plugin "${name}" missing plugin.loaded audit row. Events for this plugin: ${JSON.stringify(failures)}`);
      }
      log(`  ✓ audit: plugin.loaded for ${name}`);
    }
    log("all parity assertions passed");
  }

  // Cleanup on success; leave artifacts on failure for debugging.
  if (exitCode === 0) rmSync(root, { recursive: true, force: true });
  else log(`artifacts left at ${root} for debugging`);

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
