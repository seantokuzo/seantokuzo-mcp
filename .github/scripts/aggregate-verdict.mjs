#!/usr/bin/env node
/**
 * .github/scripts/aggregate-verdict.mjs
 *
 * Deterministic replacement for the LLM "verdict synthesizer" job in the
 * Tier 2 (claude-code-review.yml) and Tier 3 (claude-deep-review.yml)
 * auto-review pipelines.
 *
 * WHY: the old synthesizer was an Opus job running inside
 * anthropics/claude-code-action's SANDBOXED Bash tool, where pipes /
 * redirection / command-substitution / brace-adjacent quotes are blocked —
 * exactly the shell features needed to write the verdict sticky, whose body
 * contains `|`, `>`, backticks, and apostrophes. It repeatedly crashed with
 * error_max_turns fighting the quoting, despite doing only deterministic
 * arithmetic (sum counts, compare thresholds, increment a round number,
 * template a body). This script does that arithmetic in plain Node, runs in
 * a NORMAL (unsandboxed) GitHub Actions `run:` step, and writes the sticky
 * via `gh api --input -` with the body delivered as a JSON value on stdin —
 * argv + JSON-stdin means no shell ever sees the body's special bytes, so the
 * crash class is gone by construction. It also kills the Opus cost and the
 * hallucinated "auto-escalated to deep review" failure mode.
 *
 * Two entry points:
 *   - aggregate({ comments, prMeta, laneResults, tier }) — PURE function, no
 *     I/O. Returns the computed verdict + the exact sticky body. Unit-tested
 *     in aggregate-verdict.test.mjs.
 *   - main() — CLI wrapper. Reads env, fetches PR comments + metadata via gh,
 *     calls aggregate(), then creates/updates the sticky comment and (Tier 2
 *     only) applies the `claude-deep-review` escalation label.
 *
 * Invoked from a workflow `run:` step as: node .github/scripts/aggregate-verdict.mjs
 * Env: PR_NUMBER, GITHUB_REPOSITORY, GH_TOKEN, TIER (standard|deep),
 *      SECURITY_RESULT, ARCHITECTURE_RESULT, CORRECTNESS_RESULT,
 *      THREATMODEL_RESULT (each = the GitHub Actions `needs.<job>.result`).
 *
 * No product dependencies — pure Node so the workflow step needs no install.
 *
 * TRUST MODEL: sentinels are matched by marker only, with no comment-author
 * check, and most-recent-per-lane wins. On a public repo a non-bot commenter
 * could post a forged `<!-- KUZO-REVIEW-JSON-<LANE> ... -->` block and override
 * a genuine specialist verdict. This is accepted: the workflows trigger on
 * `pull_request` (not `pull_request_target`) and preflight gates the repo, so a
 * fork PR runs token-scoped with no secrets; the verdict is advisory bookkeeping
 * (the impartial judge + human merge are the real gate), not a merge gate; and
 * the old LLM synth read the same comment set with no author check either — so
 * this is a documented limitation, not a regression. An author filter on
 * `user.login` was considered and rejected as too brittle (a renamed bot login
 * would silently blank every lane). The self-poisoning guard below (skip any
 * comment carrying a sticky marker) prevents the bot's own sticky from being
 * re-parsed as a sentinel.
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
const ESCALATION_LABEL = "claude-deep-review";
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
 * Pull the relevant JSON sentinel for one lane out of the comment list.
 *
 * Specialist sentinels look like `<!-- KUZO-REVIEW-JSON-<LANE>\n{json}\n-->`.
 * Real-world data shows the JSON appears compact, spaced, AND multi-line
 * pretty-printed, so we capture everything between the marker and the first
 * `-->` (non-greedy) and JSON.parse it — never a line-based assumption.
 *
 * Rules:
 *   - comments must be chronological-ascending (aggregate() sorts them).
 *   - skip sticky comments entirely (self-poisoning guard).
 *   - parse every block; a malformed block is ignored, never thrown.
 *   - "most recent instance wins" across rounds.
 *   - tier "deep": prefer a sentinel carrying `"tier":"deep"` even if a
 *     Tier-2 sentinel is chronologically newer; fall back to most-recent.
 */
export function extractSentinel(comments, laneKey, tier) {
  const re = new RegExp(
    "<!--\\s*KUZO-REVIEW-JSON-" + laneKey + "\\s*([\\s\\S]*?)-->",
    "g",
  );
  let mostRecent = null;
  let mostRecentDeep = null;
  let sawUnparseable = false;
  for (const c of comments) {
    const body = typeof c?.body === "string" ? c.body : "";
    if (!body || isStickyComment(body)) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) !== null) {
      let parsed;
      try {
        parsed = JSON.parse(m[1].trim());
      } catch {
        sawUnparseable = true;
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
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
 * number from its `VERDICT_ROUND:` / `DEEP_VERDICT_ROUND:` marker + 1.
 * No sticky → round 1. Sticky present but round unparseable → round 2 (a
 * sticky existing implies at least one prior round happened).
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
  // A sentinel is only USABLE if it carries a recognized verdict. A parseable
  // JSON object without a valid verdict is treated as a degraded lane (not
  // "present") — never trust the LLM to have produced a usable opinion, so a
  // verdict-less sentinel can never let the aggregate report "ship".
  if (sentinel && VALID_VERDICTS.has(sentinel.verdict)) {
    return {
      id: laneId,
      emoji: meta.emoji,
      label: meta.label,
      present: true,
      verdict: sentinel.verdict,
      blocking: num(sentinel.blocking_count),
      advisory: num(sentinel.advisory_count),
      sensitive: sentinel.sensitive_paths_touched === true,
      ciFailing: typeof sentinel.ci_failing === "boolean" ? sentinel.ci_failing : null,
      topIssues: Array.isArray(sentinel.top_issues) ? sentinel.top_issues : [],
      threats: Array.isArray(sentinel.threats) ? sentinel.threats : [],
      jobResult: jobResult ?? null,
      jobOk,
      note: jobOk ? null : "job: " + jobResult,
    };
  }
  const reason = !jobOk
    ? "job-failed"
    : sentinel
      ? "no-verdict" // parseable sentinel but verdict not in the {ship,fix-then-ship,rethink} enum
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
    topIssues: [],
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

function collectActionItems(lanes, max) {
  const out = [];
  for (const sev of ["blocking", "advisory"]) {
    for (const l of lanes) {
      for (const iss of l.topIssues) {
        const severity = typeof iss?.severity === "string" ? iss.severity : "advisory";
        if (severity !== sev) continue;
        const file = typeof iss?.file === "string" ? iss.file : "?";
        const line = iss?.line != null && iss.line !== "" ? ":" + iss.line : "";
        const summary = typeof iss?.summary === "string" ? iss.summary : "(no summary)";
        out.push("- [ ] " + summary + " — `" + file + line + "`");
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

function collectThreats(lanes, max) {
  const tm = lanes.find((l) => l.id === "threatmodel");
  if (!tm || !tm.present) return [];
  return tm.threats.slice(0, max).map((t) => {
    const cat = typeof t?.category === "string" ? t.category : "?";
    const sum = typeof t?.summary === "string" ? t.summary : "(no summary)";
    return "- " + cat + ": " + sum;
  });
}

function renderSticky(a) {
  const isDeep = a.tier === "deep";
  const marker = isDeep ? "KUZO-DEEP-VERDICT-STICKY" : "KUZO-VERDICT-STICKY";
  const roundLabel = isDeep ? "DEEP_VERDICT_ROUND" : "VERDICT_ROUND";
  const title = isDeep ? "Deep Review Verdict" : "Auto-Review Verdict";
  const specialistsHeader = isDeep ? "### Specialists (deep mode)" : "### Specialists";
  const maxItems = isDeep ? 7 : 5;

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
  L.push("### Top action items");
  const items = collectActionItems(a.lanes, maxItems);
  if (items.length === 0) L.push("- _none_");
  else for (const it of items) L.push(it);
  if (isDeep) {
    L.push("");
    L.push("### Top threats (from threat model)");
    const threats = collectThreats(a.lanes, maxItems);
    if (threats.length === 0) L.push("- _none_");
    else for (const t of threats) L.push(t);
  }
  L.push("");
  L.push("---");
  L.push("");
  if (!isDeep && a.escalate) {
    L.push("> 🚨 Escalation criteria met — label `" + ESCALATION_LABEL + "` applied (reason: " + a.escalateReason + ").");
    L.push(
      "> ⚠️ The bot-applied label does NOT auto-trigger Tier 3 — GitHub suppresses workflow events from the default token. Dispatch it manually: `gh workflow run claude-deep-review.yml -f pr_number=<N>`.",
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
 * Pure — no network, no env, no process exit. Inputs:
 *   comments    : array of { id, body, created_at } (gh issue comments)
 *   prMeta      : { additions, deletions, labels, headRefOid }
 *   laneResults : { security, architecture, correctness, threatmodel } —
 *                 each the GitHub Actions `needs.<job>.result` string.
 *   tier        : "standard" | "deep"
 */
export function aggregate({ comments = [], prMeta = {}, laneResults = {}, tier = "standard" } = {}) {
  const t = tier === "deep" ? "deep" : "standard";
  const laneIds = TIER_LANES[t];

  // Order-independence: sort chronologically; ISO-8601 strings compare lexically.
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

  // Verdict ladder: rethink > fix-then-ship > ship.
  let verdict;
  if (present.some((l) => l.verdict === "rethink")) verdict = "rethink";
  else if (totalBlocking > 0) verdict = "fix-then-ship";
  else verdict = "ship";
  // Never report "ship" when a lane is missing — an unknown lane is not a clean lane.
  if (degraded && verdict === "ship") verdict = "fix-then-ship";

  const { comment: existingSticky, round } = findExistingSticky(ordered, t);

  // 4-round cap (faithful to the original LLM prose + global "max 4 rounds"):
  //   - round >= 4 is the FINAL allowed round → show the human-decides banner
  //     and suppress auto-escalation (the next step is a human, not more bot).
  //   - round > 4 means the loop ran past the cap unresolved → force "rethink".
  // A clean round-4 ship therefore stays "ship" (you CAN merge a clean final
  // round); only an over-cap round flips the verdict.
  const capReached = round >= 4;
  if (round > 4) verdict = "rethink";

  // Escalation: Tier 2 only, never at the cap.
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

  const labelNames = Array.isArray(prMeta.labels)
    ? prMeta.labels.map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean)
    : [];
  const labelAlreadyPresent = labelNames.includes(ESCALATION_LABEL);
  const applyLabel = escalate && !labelAlreadyPresent;

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
  };
  const stickyBody = renderSticky(view);

  return {
    ...view,
    sensitivePaths,
    diffTotal,
    applyLabel,
    labelAlreadyPresent,
    existingStickyId: existingSticky ? existingSticky.id : null,
    stickyBody,
  };
}

// --- CLI wrapper (I/O) ----------------------------------------------------

function gh(args, opts = {}) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

function ghJson(args) {
  return JSON.parse(gh(args));
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

  const comments = ghJson(["api", "--paginate", "repos/" + repo + "/issues/" + pr + "/comments"]);
  const prMeta = ghJson([
    "pr",
    "view",
    pr,
    "--repo",
    repo,
    "--json",
    "additions,deletions,labels,headRefOid",
  ]);

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

  if (result.applyLabel) {
    try {
      gh([
        "label",
        "create",
        ESCALATION_LABEL,
        "--repo",
        repo,
        "--color",
        "B60205",
        "--description",
        "Trigger deep multi-specialist review",
      ]);
    } catch {
      // label already exists — fine
    }
    gh(["pr", "edit", pr, "--repo", repo, "--add-label", ESCALATION_LABEL]);
    console.log("✓ applied escalation label (" + result.escalateReason + ")");
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
