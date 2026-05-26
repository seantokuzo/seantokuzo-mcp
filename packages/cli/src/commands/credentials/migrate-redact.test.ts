/**
 * migrate-redact.test.ts — Phase 2.6 §B.4 step 3 redaction.
 *
 * Centerpiece is the §F.1 canonical fixture: a multi-line double-quoted value, a
 * plain value, an `export`-prefixed value, leading/trailing comments, and a
 * blank line. After dropping the credential the rewrite must keep everything
 * else byte-for-byte and leave NO fragment of the dropped value's second line.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parse as parseDotenv } from "dotenv";

import {
  isKuzoMcpEntry,
} from "./migrate-discovery.js";
import {
  redactDotenv,
  redactSettingsJson,
  verifyDotenvRedaction,
  verifySettingsRedaction,
} from "./migrate-redact.js";

// §F.1 canonical fixture.
const FIXTURE = [
  "# leading comment, preserved",
  'GITHUB_TOKEN="ghp_xxxxx',
  'trailing-line-that-is-actually-part-of-the-value"',
  "LOG_LEVEL=info",
  "export OPENAI_API_KEY=sk-...",
  "",
  "# trailing comment, preserved",
  "",
].join("\n");

test("dotenv: the §F.1 multi-line value drops cleanly, everything else verbatim", () => {
  // Sanity: dotenv folds the two physical lines into one multi-line value.
  const parsed = parseDotenv(FIXTURE);
  assert.ok(parsed.GITHUB_TOKEN?.includes("\n"), "fixture value should be multi-line");
  assert.equal(parsed.LOG_LEVEL, "info");
  assert.equal(parsed.OPENAI_API_KEY, "sk-...");

  const out = redactDotenv(FIXTURE, new Set(["GITHUB_TOKEN"]));

  assert.equal(
    out,
    [
      "# leading comment, preserved",
      "LOG_LEVEL=info",
      "export OPENAI_API_KEY=sk-...",
      "",
      "# trailing comment, preserved",
      "",
    ].join("\n"),
  );
  // No fragment of either physical line survives.
  assert.ok(!out.includes("ghp_xxxxx"));
  assert.ok(!out.includes("trailing-line-that-is-actually-part-of-the-value"));
  // The result still parses (no orphan quote state) and the value is gone.
  const reparsed = parseDotenv(out);
  assert.equal(reparsed.GITHUB_TOKEN, undefined);
  assert.equal(reparsed.LOG_LEVEL, "info");
  assert.equal(reparsed.OPENAI_API_KEY, "sk-...");
});

test("dotenv: verify reports zero leaks after a correct multi-line drop", () => {
  const out = redactDotenv(FIXTURE, new Set(["GITHUB_TOKEN"]));
  const dropped = new Map([["GITHUB_TOKEN", parseDotenv(FIXTURE).GITHUB_TOKEN ?? ""]]);
  assert.deepEqual(verifyDotenvRedaction(out, dropped), []);
});

test("dotenv: verify catches an orphaned value fragment a name-only check would miss", () => {
  // Simulate a buggy line-strip that removed only the FIRST physical line and
  // left the quoted continuation behind. dotenv.parse yields no GITHUB_TOKEN
  // key (the orphan line has no `=`), so a name-only check passes — but the
  // value-fragment backstop must flag it.
  const buggy = [
    "# leading comment, preserved",
    'trailing-line-that-is-actually-part-of-the-value"',
    "LOG_LEVEL=info",
  ].join("\n");
  const dropped = new Map([["GITHUB_TOKEN", parseDotenv(FIXTURE).GITHUB_TOKEN ?? ""]]);
  assert.equal(parseDotenv(buggy).GITHUB_TOKEN, undefined, "name not parseable in buggy output");
  const leaks = verifyDotenvRedaction(buggy, dropped);
  assert.ok(leaks.some((l) => l.kind === "fragment" && l.name === "GITHUB_TOKEN"));
});

test("dotenv: single-quoted and escaped-quote values keep correct extents", () => {
  const raw = [
    "KEEP=plain",
    "DROP_ME='single\\'quote inside'",
    "ALSO_KEEP=after",
  ].join("\n");
  const out = redactDotenv(raw, new Set(["DROP_ME"]));
  assert.equal(out, ["KEEP=plain", "ALSO_KEEP=after"].join("\n"));
});

test("dotenv: dropping a key with an inline comment removes the whole line", () => {
  const raw = ["GITHUB_TOKEN=ghp_abc # work token", "KEEP=yes"].join("\n");
  const out = redactDotenv(raw, new Set(["GITHUB_TOKEN"]));
  assert.equal(out, "KEEP=yes");
  assert.ok(!out.includes("work token"));
});

test("settings.json: drops keys only from kuzo entries, preserving 2-space indent", () => {
  const settings = JSON.stringify(
    {
      mcpServers: {
        kuzo: {
          command: "kuzo",
          args: ["serve"],
          env: { GITHUB_TOKEN: "ghp_secret", LOG_LEVEL: "debug" },
        },
        other: {
          command: "other-server",
          env: { GITHUB_TOKEN: "not-ours" },
        },
      },
    },
    null,
    2,
  );

  const out = redactSettingsJson(settings, new Set(["GITHUB_TOKEN"]));
  const parsed = JSON.parse(out) as {
    mcpServers: Record<string, { env?: Record<string, string> }>;
  };

  assert.equal(parsed.mcpServers.kuzo?.env?.GITHUB_TOKEN, undefined, "dropped from kuzo");
  assert.equal(parsed.mcpServers.kuzo?.env?.LOG_LEVEL, "debug", "non-cred kept");
  assert.equal(parsed.mcpServers.other?.env?.GITHUB_TOKEN, "not-ours", "untouched non-kuzo entry");
  // Indent preserved (2 spaces).
  assert.ok(out.includes('\n  "mcpServers"'));
  assert.deepEqual(
    verifySettingsRedaction(out, new Map([["GITHUB_TOKEN", "ghp_secret"]])),
    [],
  );
});

test("settings.json: detects and preserves a node-invocation kuzo entry", () => {
  assert.ok(
    isKuzoMcpEntry({
      command: "node",
      args: ["/abs/path/node_modules/@kuzo-mcp/core/dist/server.js"],
    }),
  );
  assert.ok(isKuzoMcpEntry({ command: "/usr/local/bin/kuzo", args: ["serve"] }));
  assert.ok(!isKuzoMcpEntry({ command: "some-other-mcp", args: ["run"] }));
});
