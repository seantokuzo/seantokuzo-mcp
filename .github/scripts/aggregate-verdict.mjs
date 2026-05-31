#!/usr/bin/env node
/**
 * .github/scripts/aggregate-verdict.mjs
 *
 * Deterministic replacement for the LLM "verdict synthesizer" job in the
 * Tier 2 (claude-code-review.yml) and Tier 3 (claude-deep-review.yml)
 * auto-review pipelines. Runs in a normal (unsandboxed) GitHub Actions `run:`
 * step — no LLM, no Opus cost, no turn budget. Posts the verdict sticky via
 * `gh api --input -` with the body as a JSON value on stdin, so no shell ever
 * parses the body's special bytes.
 *
 * SENTINEL FORMAT (line-based, NOT JSON). Specialists emit:
 *   <!-- KUZO-REVIEW-<LANE>
 *   verdict: ship | fix-then-ship | rethink
 *   blocking: <N>
 *   advisory: <N>
 *   sensitive: true | false
 *   ci_failing: true | false      (correctness lane)
 *   tier: deep                    (deep review only)
 *   threat: <S|T|R|I|D|E> | <summary>   (threat-model lane, repeatable)
 *   -->
 * WHY line format: claude-code-action's in-sandbox Bash validator hard-blocks
 * any `gh pr comment` whose body contains `{` adjacent to `"` ("expansion
 * obfuscation"), which is exactly the shape of a JSON sentinel — so specialists
 * could not reliably post a JSON sentinel (observed on PR #61). A `key: value`
 * block has no braces or quotes, so it always passes. Specialists post the
 * sentinel as a DEDICATED comment (no free text → can never reintroduce `{"`).
 *
 * The aggregator scans BOTH issue comments and inline (pulls) review comments,
 * so a sentinel posted via the validator-immune MCP inline tool is still found.
 *
 * TRUST MODEL: sentinels are matched by marker only, no comment-author check,
 * most-recent-per-lane wins. On a public repo a non-bot commenter could forge a
 * sentinel. Accepted: workflows trigger on dispatch / pull_request (never
 * pull_request_target), preflight gates the repo, the verdict is advisory
 * bookkeeping (the impartial judge + human merge are the real gate), and an
 * author filter on `user.login` was rejected as too brittle (a renamed bot login
 * would blank every lane). The self-poisoning guard (skip comments carrying a
 * sticky marker) prevents the bot's own sticky from being re-parsed.
 *
 * Two entry points:
 *   - aggregate({ comments, prMeta, laneResults, tier }) — PURE, no I/O.
 *   - main() — CLI: fetch comments + PR meta via gh, aggregate, post the sticky.
 *
 * Env: PR_NUMBER, GITHUB_REPOSITORY, GH_TOKEN, TIER (standard|deep),
 *      SECURITY_RESULT, ARCHITECTURE_RESULT, CORRECTNESS_RESULT, THREATMODEL_RESULT.
 * No product dependencies — pure Node so the workflow step needs no install.
 */

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// --- lane + tier configuration -------------------------------------------

const LANES = {
  security: { key: "SECURITY", emoji: "🔒", label: "Security" },
  architecture: { key: "ARCHITECTURE", emoji: "🏗️", label: "Architecture" },
  correctness: { key: "CORRECTNESS", emoji: "✅", label: "Correctness" },
  threatmodel: { key: "THREATMODEL", emoji: "🎯", label: "Threat Model" },
};

const TIER_LANES = {
  standard: ["security", "architecture", "correctness"],
  deep: ["security", "architecture", "correctness", "threatmodel"],
};

const STICKY_MARKERS = ["KUZO-DEEP-VERDICT-STICKY", "KUZO-VERDICT-STICKY"];
const VALID_VERDICTS = new Set(["ship", "fix-then-ship", "rethink"]);

// --- small helpers --------------------------------------------------------

/** Coerce a value to a non-negative integer; anything weird becomes 0. */
function num(v) {
  const n = typeof v === "number" ? v : parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** A comment is "sticky" (a verdict comment, not a sentinel) if it carries a sticky marker. */
function isStickyComment(body) {
  return STICKY_MARKERS.some((m) => body.includes(m));
}

// --- sentinel + sticky extraction (pure) ----------------------------------

/**
 * Parse a line-format sentinel body into a field map. Returns null if no
 * `key: value` line is present. `threat:` lines accumulate into `threats`.
 */
function parseSentinelLines(text) {
  const map = {};
  const threats = [];
  let sawKey = false;
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (!key) continue;
    if (key === "threat") {
      if (val) threats.push(val);
      sawKey = true;
      continue;
    }
    map[key] = val;
    sawKey = true;
  }
  if (!sawKey) return null;
  if (threats.length) map.threats = threats;
  return map;
}

/**
 * Pull the relevant sentinel for one lane out of the comment list.
 *   - comments must be chronological-ascending (aggregate() sorts them).
 *   - skip sticky comments (self-poisoning guard).
 *   - "most recent instance wins" across rounds.
 *   - tier "deep": prefer a sentinel carrying `tier: deep` even if a Tier-2
 *     sentinel is chronologically newer; else most-recent.
 */
export function extractSentinel(comments, laneKey, tier) {
  // \b after the lane key prevents KUZO-REVIEW-SECURITY matching e.g. a
  // mistyped KUZO-REVIEW-SECURITYEXTRA marker.
  const re = new RegExp("<!--\\s*KUZO-REVIEW-" + laneKey + "\\b\\s*([\\s\\S]*?)-->", "g");
  let mostRecent = null;
  let mostRecentDeep = null;
  let sawUnparseable = false;
  for (const c of comments) {
    const body = typeof c?.body === "string" ? c.body : "";
    if (!body || isStickyComment(body)) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) !== null) {
      const parsed = parseSentinelLines(m[1]);
      if (!parsed) {
        sawUnparseable = true;
        continue;
      }
      mostRecent = parsed;
      if (parsed.tier === "deep") mostRecentDeep = parsed;
    }
  }
  const sentinel = tier === "deep" && mostRecentDeep ? mostRecentDeep : mostRecent;
  return { sentinel, sawUnparseable: sentinel ? false : sawUnparseable };
}

/**
 * Find the existing verdict sticky (last one wins) and compute THIS round's
 * number from its round marker + 1. No sticky → round 1. Sticky present but
 * round unparseable → round 2 (a sticky implies a prior round happened).
 */
export function findExistingSticky(comments, tier) {
  const marker = tier === "deep" ? "KUZO-DEEP-VERDICT-STICKY" : "KUZO-VERDICT-STICKY";
  const roundLabel = tier === "deep" ? "DEEP_VERDICT_ROUND" : "VERDICT_ROUND";
  let found = null;
  for (const c of comments) {
    const body = typeof c?.body === "string" ? c.body : "";
    if (body.includes(marker)) found = c;
  }
  if (!found) return { comment: null, round: 1 };
  const m = String(found.body).match(new RegExp(roundLabel + ":\\s*(\\d+)"));
  const prev = m ? parseInt(m[1], 10) : null;
  return { comment: found, round: prev !== null ? prev + 1 : 2 };
}

/** Build a normalized lane object from the comments + the job's `result`. */
function buildLane(comments, laneId, tier, jobResult) {
  const meta = LANES[laneId];
  const { sentinel, sawUnparseable } = extractSentinel(comments, meta.key, tier);
  const jobOk = jobResult === undefined || jobResult === "" || jobResult === "success";
  // A sentinel is USABLE only if it carries a recognized verdict. A sentinel
  // without a valid verdict is a degraded lane (never "present"), so it can
  // never let the aggregate report "ship".
  if (sentinel && VALID_VERDICTS.has(sentinel.verdict)) {
    return {
      id: laneId,
      emoji: meta.emoji,
      label: meta.label,
      present: true,
      verdict: sentinel.verdict,
      blocking: num(sentinel.blocking),
      advisory: num(sentinel.advisory),
      sensitive: sentinel.sensitive === "true",
      ciFailing: sentinel.ci_failing === "true" ? true : sentinel.ci_failing === "false" ? false : null,
      threats: Array.isArray(sentinel.threats) ? sentinel.threats : [],
      jobResult: jobResult ?? null,
      jobOk,
      note: jobOk ? null : "job: " + jobResult,
    };
  }
  const reason = !jobOk
    ? "job-failed"
    : sentinel
      ? "no-verdict" // a sentinel was parsed but its verdict is not in the enum
      : sawUnparseable
        ? "malformed-sentinel"
        : "no-sentinel";
  return {
    id: laneId,
    emoji: meta.emoji,
    label: meta.label,
    present: false,
    verdict: null,
    blocking: 0,
    advisory: 0,
    sensitive: false,
    ciFailing: null,
    threats: [],
    jobResult: jobResult ?? null,
    jobOk,
    reason,
  };
}

// --- sticky body rendering (pure) -----------------------------------------

function laneLine(l) {
  if (!l.present) {
    return "- " + l.emoji + " " + l.label + ": ⚠️ no verdict (" + l.reason + ")";
  }
  const note = l.jobOk ? "" : " — ⚠️ " + l.note;
  return (
    "- " + l.emoji + " " + l.label + ": " + l.verdict +
    " (" + l.blocking + " blocking, " + l.advisory + " advisory)" + note
  );
}

function collectThreats(lanes, max) {
  const tm = lanes.find((l) => l.id === "threatmodel");
  if (!tm || !tm.present) return [];
  return tm.threats.slice(0, max).map((t) => {
    // threat line is "<category> | <summary>"; tolerate a missing pipe.
    const bar = t.indexOf("|");
    const cat = bar >= 0 ? t.slice(0, bar).trim() : "?";
    const sum = bar >= 0 ? t.slice(bar + 1).trim() : t.trim();
    return "- " + (cat || "?") + ": " + (sum || "(no summary)");
  });
}

function renderSticky(a) {
  const isDeep = a.tier === "deep";
  const marker = isDeep ? "KUZO-DEEP-VERDICT-STICKY" : "KUZO-VERDICT-STICKY";
  const roundLabel = isDeep ? "DEEP_VERDICT_ROUND" : "VERDICT_ROUND";
  const title = isDeep ? "Deep Review Verdict" : "Auto-Review Verdict";
  const specialistsHeader = isDeep ? "### Specialists (deep mode)" : "### Specialists";

  const L = [];
  L.push("<!-- " + marker + " -->");
  L.push("<!-- " + roundLabel + ": " + a.round + " -->");
  if (a.headSha) L.push("<!-- VERDICT_HEAD_SHA: " + a.headSha + " -->");
  L.push("");
  L.push("## 📋 " + title + " — Round " + a.round);
  L.push("");
  L.push("**Verdict**: " + a.verdict);
  L.push("**Blocking**: " + a.totalBlocking + " | **Advisory**: " + a.totalAdvisory);
  if (!isDeep) {
    const ciText = a.ciFailing === true ? "red" : a.ciFailing === false ? "green" : "unknown";
    L.push("**CI**: " + ciText);
  }
  L.push("");
  if (a.degraded) {
    L.push(
      "> ⚠️ One or more specialist lanes produced no usable verdict this round — the verdict is incomplete. Re-run the affected lane(s) before merging.",
    );
    L.push("");
  }
  L.push(specialistsHeader);
  for (const l of a.lanes) L.push(laneLine(l));
  L.push("");
  if (isDeep) {
    L.push("### Top threats (from threat model)");
    const threats = collectThreats(a.lanes, 7);
    if (threats.length === 0) L.push("- _none_");
    else for (const t of threats) L.push(t);
    L.push("");
  }
  L.push("_Line-level findings are in the specialist comments + inline review threads above._");
  L.push("");
  L.push("---");
  L.push("");
  if (!isDeep && a.escalate) {
    L.push("> 🚨 Escalation criteria met (reason: " + a.escalateReason + ").");
    L.push(
      "> Consider a deep review: `gh workflow run claude-deep-review.yml -f pr_number=" + (a.prNumber || "<N>") + "`.",
    );
    L.push("");
  }
  if (a.capReached) {
    L.push("> 🚨 4-round cap reached. Human decision required to merge or close.");
    L.push("");
  }
  L.push(
    "🤖 _Verdict computed deterministically by `.github/scripts/aggregate-verdict.mjs` from " +
      a.lanes.length +
      " specialist sentinels (no LLM)._",
  );
  return L.join("\n");
}

// --- the pure aggregator --------------------------------------------------

/**
 * Compute the aggregate verdict + sticky body from PR comments + metadata.
 * Pure — no network, no env, no process exit. `comments` should include both
 * issue comments and inline (pulls) review comments. Escalation is computed as
 * a RECOMMENDATION only (dispatch-only model — no label is applied, since the
 * deep tier is triggered manually via workflow_dispatch).
 */
export function aggregate({ comments = [], prMeta = {}, laneResults = {}, tier = "standard" } = {}) {
  const t = tier === "deep" ? "deep" : "standard";
  const laneIds = TIER_LANES[t];

  const ordered = [...comments].sort((a, b) =>
    String(a?.created_at ?? "").localeCompare(String(b?.created_at ?? "")),
  );

  const lanes = laneIds.map((id) => buildLane(ordered, id, t, laneResults[id]));
  const present = lanes.filter((l) => l.present);
  const degraded = lanes.some((l) => !l.present);

  const totalBlocking = present.reduce((s, l) => s + l.blocking, 0);
  const totalAdvisory = present.reduce((s, l) => s + l.advisory, 0);
  const sensitivePaths = present.some((l) => l.sensitive);
  const correctness = lanes.find((l) => l.id === "correctness");
  const ciFailing = correctness && correctness.present ? correctness.ciFailing : null;

  let verdict;
  if (present.some((l) => l.verdict === "rethink")) verdict = "rethink";
  else if (totalBlocking > 0) verdict = "fix-then-ship";
  else verdict = "ship";
  if (degraded && verdict === "ship") verdict = "fix-then-ship";

  const { comment: existingSticky, round } = findExistingSticky(ordered, t);

  // 4-round cap: round >= 4 is the final allowed round (banner + escalation
  // suppressed); round > 4 forces "rethink". A clean round-4 ship stays ship.
  const capReached = round >= 4;
  if (round > 4) verdict = "rethink";

  // Escalation RECOMMENDATION (standard tier, not at the cap). No label is
  // applied — Tier 3 is dispatched manually under the dispatch-only model.
  const diffTotal = num(prMeta.additions) + num(prMeta.deletions);
  let escalate = false;
  let escalateReason = null;
  if (t === "standard" && !capReached) {
    if (verdict === "rethink") {
      escalate = true;
      escalateReason = "rethink-verdict";
    } else if (sensitivePaths && totalBlocking > 0) {
      escalate = true;
      escalateReason = "sensitive-paths-with-blocking";
    } else if (totalBlocking > 5) {
      escalate = true;
      escalateReason = ">5-blocking";
    } else if (diffTotal > 500) {
      escalate = true;
      escalateReason = "large-diff";
    }
  }

  const headSha = typeof prMeta.headRefOid === "string" && /^[0-9a-f]{7,64}$/.test(prMeta.headRefOid)
    ? prMeta.headRefOid
    : null;

  const view = {
    tier: t,
    round,
    verdict,
    totalBlocking,
    totalAdvisory,
    ciFailing,
    lanes,
    escalate,
    escalateReason,
    capReached,
    degraded,
    headSha,
    prNumber: prMeta.number ?? null,
  };
  const stickyBody = renderSticky(view);

  return {
    ...view,
    sensitivePaths,
    diffTotal,
    existingStickyId: existingSticky ? existingSticky.id : null,
    stickyBody,
  };
}

// --- CLI wrapper (I/O) ----------------------------------------------------

function gh(args, opts = {}) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

function ghJsonSafe(args, fallback) {
  try {
    return JSON.parse(gh(args));
  } catch (err) {
    console.error("⚠️ gh " + args.join(" ") + " failed: " + (err instanceof Error ? err.message : String(err)));
    return fallback;
  }
}

function required(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    console.error("✗ aggregate-verdict: missing required env " + name);
    process.exit(1);
  }
  return String(v).trim();
}

function main() {
  const tier = (process.env.TIER ?? "standard").trim() === "deep" ? "deep" : "standard";
  const repo = required("GITHUB_REPOSITORY");
  const pr = required("PR_NUMBER");
  const laneResults = {
    security: process.env.SECURITY_RESULT,
    architecture: process.env.ARCHITECTURE_RESULT,
    correctness: process.env.CORRECTNESS_RESULT,
    threatmodel: process.env.THREATMODEL_RESULT,
  };

  // Sentinels may land as a top-level issue comment OR (validator-immune
  // fallback) an inline review comment — scan both endpoints.
  const issueComments = ghJsonSafe(["api", "--paginate", "repos/" + repo + "/issues/" + pr + "/comments"], []);
  const inlineComments = ghJsonSafe(["api", "--paginate", "repos/" + repo + "/pulls/" + pr + "/comments"], []);
  const comments = [...issueComments, ...inlineComments];

  const prMeta = ghJsonSafe(
    ["pr", "view", pr, "--repo", repo, "--json", "additions,deletions,headRefOid,number"],
    {},
  );

  const result = aggregate({ comments, prMeta, laneResults, tier });

  // Post or update the sticky. Body travels as a JSON value on stdin via
  // `--input -`, so no shell ever parses its `|` / `>` / backtick bytes.
  const payload = JSON.stringify({ body: result.stickyBody });
  if (result.existingStickyId != null) {
    gh(["api", "-X", "PATCH", "repos/" + repo + "/issues/comments/" + result.existingStickyId, "--input", "-"], {
      input: payload,
    });
    console.log("✓ updated sticky comment " + result.existingStickyId);
  } else {
    gh(["api", "-X", "POST", "repos/" + repo + "/issues/" + pr + "/comments", "--input", "-"], {
      input: payload,
    });
    console.log("✓ created sticky comment");
  }

  console.log(
    "verdict=" + result.verdict +
      " round=" + result.round +
      " blocking=" + result.totalBlocking +
      " advisory=" + result.totalAdvisory +
      " escalate=" + result.escalate +
      " cap=" + result.capReached +
      " degraded=" + result.degraded,
  );
}

// Run main() only when invoked directly (not when imported by the test file).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error("✗ aggregate-verdict failed: " + (err instanceof Error ? err.stack : String(err)));
    process.exit(1);
  }
}
