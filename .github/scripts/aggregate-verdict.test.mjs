#!/usr/bin/env node
/**
 * .github/scripts/aggregate-verdict.test.mjs
 *
 * Unit tests for the deterministic verdict aggregator. Pure — exercises the
 * exported aggregate()/extractSentinel()/findExistingSticky() functions with
 * synthetic comment fixtures plus a captured real PR (#57) comment array.
 *
 * Run: node --test .github/scripts/
 * No deps, no build, no pnpm — first-class node:test on plain .mjs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { aggregate, extractSentinel, findExistingSticky } from "./aggregate-verdict.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// --- fixture helpers ------------------------------------------------------

let _id = 1000;
let _t = 0;
function ts() {
  _t += 1;
  return "2026-01-01T00:00:" + String(_t).padStart(2, "0") + "Z";
}
/** A specialist summary comment carrying a lane sentinel. */
function mk(laneKey, obj, at = ts()) {
  return {
    id: _id++,
    created_at: at,
    body:
      "<!-- KUZO-REVIEW-JSON-" + laneKey + "\n" + JSON.stringify(obj) + "\n-->\n\n## " +
      laneKey + " Review\n\nhuman-readable findings here",
  };
}
/** An existing verdict sticky at a given round. */
function sticky(round, tier = "standard", at = ts()) {
  const marker = tier === "deep" ? "KUZO-DEEP-VERDICT-STICKY" : "KUZO-VERDICT-STICKY";
  const rl = tier === "deep" ? "DEEP_VERDICT_ROUND" : "VERDICT_ROUND";
  return {
    id: _id++,
    created_at: at,
    body: "<!-- " + marker + " -->\n<!-- " + rl + ": " + round + " -->\n\n## Verdict — Round " + round,
  };
}
const META = { additions: 10, deletions: 5, labels: [], headRefOid: "abc1234def5678" };
const ALL_OK = { security: "success", architecture: "success", correctness: "success" };
const ALL_OK_DEEP = { ...ALL_OK, threatmodel: "success" };

function ship(extra = {}) {
  return { verdict: "ship", blocking_count: 0, advisory_count: 0, sensitive_paths_touched: false, ...extra };
}

// --- tests ----------------------------------------------------------------

test("1. all lanes ship, round 1 → ship, no escalation, head sha marker", () => {
  const comments = [
    mk("SECURITY", ship({ advisory_count: 1 })),
    mk("ARCHITECTURE", ship()),
    mk("CORRECTNESS", ship({ ci_failing: false })),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.verdict, "ship");
  assert.equal(r.round, 1);
  assert.equal(r.escalate, false);
  assert.equal(r.capReached, false);
  assert.equal(r.degraded, false);
  assert.equal(r.totalBlocking, 0);
  assert.equal(r.totalAdvisory, 1);
  assert.match(r.stickyBody, /<!-- VERDICT_ROUND: 1 -->/);
  assert.match(r.stickyBody, /<!-- VERDICT_HEAD_SHA: abc1234def5678 -->/);
});

test("2. any rethink → overall rethink + escalate(rethink-verdict)", () => {
  const comments = [
    mk("SECURITY", { verdict: "rethink", blocking_count: 1, advisory_count: 0, sensitive_paths_touched: false }),
    mk("ARCHITECTURE", ship()),
    mk("CORRECTNESS", ship({ ci_failing: false })),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.verdict, "rethink");
  assert.equal(r.escalate, true);
  assert.equal(r.escalateReason, "rethink-verdict");
  assert.equal(r.applyLabel, true);
});

test("3. blocking>0 but no rethink → fix-then-ship", () => {
  const comments = [
    mk("SECURITY", { verdict: "fix-then-ship", blocking_count: 2, advisory_count: 0, sensitive_paths_touched: false }),
    mk("ARCHITECTURE", ship()),
    mk("CORRECTNESS", ship({ ci_failing: false })),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.verdict, "fix-then-ship");
  assert.equal(r.totalBlocking, 2);
});

test("4. >5-blocking escalation boundary: 5 no, 6 yes", () => {
  const make = (secB, archB) => [
    mk("SECURITY", { verdict: "fix-then-ship", blocking_count: secB, advisory_count: 0, sensitive_paths_touched: false }),
    mk("ARCHITECTURE", { verdict: "fix-then-ship", blocking_count: archB, advisory_count: 0, sensitive_paths_touched: false }),
    mk("CORRECTNESS", ship({ ci_failing: false })),
  ];
  const five = aggregate({ comments: make(3, 2), prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(five.totalBlocking, 5);
  assert.equal(five.escalate, false);
  const six = aggregate({ comments: make(3, 3), prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(six.totalBlocking, 6);
  assert.equal(six.escalate, true);
  assert.equal(six.escalateReason, ">5-blocking");
});

test("5. large-diff escalation boundary: 500 no, 501 yes (verdict still ship)", () => {
  const comments = [mk("SECURITY", ship()), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))];
  const at500 = aggregate({ comments, prMeta: { ...META, additions: 300, deletions: 200 }, laneResults: ALL_OK, tier: "standard" });
  assert.equal(at500.verdict, "ship");
  assert.equal(at500.escalate, false);
  const at501 = aggregate({ comments, prMeta: { ...META, additions: 301, deletions: 200 }, laneResults: ALL_OK, tier: "standard" });
  assert.equal(at501.escalate, true);
  assert.equal(at501.escalateReason, "large-diff");
});

test("6. sensitive paths: alone no escalate, +blocking escalates", () => {
  const sensNoBlock = [
    mk("SECURITY", ship({ sensitive_paths_touched: true })),
    mk("ARCHITECTURE", ship()),
    mk("CORRECTNESS", ship({ ci_failing: false })),
  ];
  const a = aggregate({ comments: sensNoBlock, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(a.sensitivePaths, true);
  assert.equal(a.escalate, false);
  const sensBlock = [
    mk("SECURITY", { verdict: "fix-then-ship", blocking_count: 1, advisory_count: 0, sensitive_paths_touched: true }),
    mk("ARCHITECTURE", ship()),
    mk("CORRECTNESS", ship({ ci_failing: false })),
  ];
  const b = aggregate({ comments: sensBlock, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(b.escalate, true);
  assert.equal(b.escalateReason, "sensitive-paths-with-blocking");
});

test("7. round parsing: none→1, sticky:2→3, sticky-without-round→2", () => {
  const sentinels = () => [mk("SECURITY", ship()), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))];
  const none = aggregate({ comments: sentinels(), prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(none.round, 1);

  const r2 = findExistingSticky([sticky(2)], "standard");
  assert.equal(r2.round, 3);

  const noRound = { id: 999, created_at: ts(), body: "<!-- KUZO-VERDICT-STICKY -->\n\n## Verdict (round marker missing)" };
  const r = findExistingSticky([noRound], "standard");
  assert.equal(r.round, 2);
});

test("8. cap: round 4 is final (banner, NOT forced, escalation suppressed); round 5 forces rethink", () => {
  const cleanSentinels = (at1, at2, at3) => [
    mk("SECURITY", ship(), at1),
    mk("ARCHITECTURE", ship(), at2),
    mk("CORRECTNESS", ship({ ci_failing: false }), at3),
  ];
  // existing sticky round 3 → this round 4; clean ship; even a huge diff must NOT escalate at the cap.
  const round4 = aggregate({
    comments: [sticky(3, "standard", "2026-01-01T00:00:01Z"), ...cleanSentinels("2026-01-01T00:00:02Z", "2026-01-01T00:00:03Z", "2026-01-01T00:00:04Z")],
    prMeta: { ...META, additions: 9000, deletions: 9000 },
    laneResults: ALL_OK,
    tier: "standard",
  });
  assert.equal(round4.round, 4);
  assert.equal(round4.capReached, true);
  assert.equal(round4.verdict, "ship", "clean round 4 stays ship");
  assert.equal(round4.escalate, false, "escalation suppressed at the cap");
  assert.match(round4.stickyBody, /4-round cap reached/);

  // existing sticky round 4 → this round 5 → forced rethink.
  const round5 = aggregate({
    comments: [sticky(4, "standard", "2026-01-01T00:00:01Z"), ...cleanSentinels("2026-01-01T00:00:02Z", "2026-01-01T00:00:03Z", "2026-01-01T00:00:04Z")],
    prMeta: META,
    laneResults: ALL_OK,
    tier: "standard",
  });
  assert.equal(round5.round, 5);
  assert.equal(round5.verdict, "rethink", "over-cap forces rethink");
  assert.equal(round5.escalate, false, "no auto-escalation past the cap");
});

test("9a. missing lane (job-failed) → degraded, never ship, no auto-escalate", () => {
  const comments = [mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))];
  const r = aggregate({ comments, prMeta: META, laneResults: { security: "failure", architecture: "success", correctness: "success" }, tier: "standard" });
  assert.equal(r.degraded, true);
  assert.equal(r.verdict, "fix-then-ship", "missing lane floors verdict above ship");
  assert.equal(r.escalate, false);
  const sec = r.lanes.find((l) => l.id === "security");
  assert.equal(sec.present, false);
  assert.equal(sec.reason, "job-failed");
  assert.match(r.stickyBody, /no verdict \(job-failed\)/);
});

test("9b. missing lane (no sentinel posted, job ok) → reason no-sentinel", () => {
  const comments = [mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.lanes.find((l) => l.id === "security").reason, "no-sentinel");
});

test("9c. malformed sentinel JSON → reason malformed-sentinel, no throw", () => {
  const bad = { id: _id++, created_at: ts(), body: "<!-- KUZO-REVIEW-JSON-SECURITY\n{ this is : not json, }\n-->" };
  const comments = [bad, mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.lanes.find((l) => l.id === "security").reason, "malformed-sentinel");
});

test("10. most-recent sentinel wins across rounds", () => {
  const comments = [
    mk("SECURITY", ship(), "2026-01-01T00:00:01Z"), // round 1: ship
    mk("ARCHITECTURE", ship(), "2026-01-01T00:00:02Z"),
    mk("CORRECTNESS", ship({ ci_failing: false }), "2026-01-01T00:00:03Z"),
    mk("SECURITY", { verdict: "rethink", blocking_count: 1, advisory_count: 0, sensitive_paths_touched: false }, "2026-01-01T00:00:10Z"), // round 2: rethink
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.lanes.find((l) => l.id === "security").verdict, "rethink");
  assert.equal(r.verdict, "rethink");
});

test("11. deep-tier precedence: deep sentinel beats a chronologically-newer Tier-2 one", () => {
  const comments = [
    mk("SECURITY", { ...ship(), tier: "deep" }, "2026-01-01T00:00:01Z"), // deep: ship (older)
    mk("SECURITY", { verdict: "rethink", blocking_count: 2, advisory_count: 0, sensitive_paths_touched: false }, "2026-01-01T00:00:09Z"), // tier-2: rethink (newer)
    mk("ARCHITECTURE", { ...ship(), tier: "deep" }),
    mk("CORRECTNESS", { ...ship({ ci_failing: false }), tier: "deep" }),
    mk("THREATMODEL", { verdict: "ship", blocking_count: 0, advisory_count: 0, sensitive_paths_touched: false, threats: [], tier: "deep" }),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK_DEEP, tier: "deep" });
  assert.equal(r.lanes.find((l) => l.id === "security").verdict, "ship", "deep sentinel preferred");
  assert.equal(r.verdict, "ship");
});

test("12. self-poisoning guard: a sticky quoting a sentinel marker is not parsed", () => {
  const poison = {
    id: _id++,
    created_at: ts(),
    body: "<!-- KUZO-VERDICT-STICKY -->\n<!-- VERDICT_ROUND: 1 -->\n\nExample: `<!-- KUZO-REVIEW-JSON-SECURITY {\"verdict\":\"ship\"} -->`",
  };
  const comments = [poison, mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  const sec = r.lanes.find((l) => l.id === "security");
  assert.equal(sec.present, false, "security sentinel must NOT be read from the sticky body");
});

test("13. ci_failing maps to CI line: true→red, false→green, absent→unknown", () => {
  const base = (corr) => [mk("SECURITY", ship()), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", corr)];
  const red = aggregate({ comments: base(ship({ ci_failing: true })), prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(red.ciFailing, true);
  assert.match(red.stickyBody, /\*\*CI\*\*: red/);
  const green = aggregate({ comments: base(ship({ ci_failing: false })), prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.match(green.stickyBody, /\*\*CI\*\*: green/);
  const unknown = aggregate({ comments: base(ship()), prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(unknown.ciFailing, null);
  assert.match(unknown.stickyBody, /\*\*CI\*\*: unknown/);
});

test("14. deep tier: threat-model threats render, no top_issues crash, no CI line, no escalation block", () => {
  const comments = [
    mk("SECURITY", { ...ship({ sensitive_paths_touched: true }), tier: "deep" }),
    mk("ARCHITECTURE", { ...ship(), tier: "deep" }),
    mk("CORRECTNESS", { ...ship({ ci_failing: false }), tier: "deep" }),
    mk("THREATMODEL", {
      verdict: "ship",
      blocking_count: 0,
      advisory_count: 1,
      sensitive_paths_touched: true,
      threats: [{ category: "S", severity: "advisory", summary: "token confusion possible" }],
      tier: "deep",
    }),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK_DEEP, tier: "deep" });
  assert.equal(r.lanes.length, 4);
  assert.match(r.stickyBody, /<!-- KUZO-DEEP-VERDICT-STICKY -->/);
  assert.match(r.stickyBody, /Specialists \(deep mode\)/);
  assert.match(r.stickyBody, /### Top threats/);
  assert.match(r.stickyBody, /- S: token confusion possible/);
  assert.doesNotMatch(r.stickyBody, /\*\*CI\*\*/);
  assert.doesNotMatch(r.stickyBody, /Auto-escalated to deep review/);
  assert.equal(r.applyLabel, false);
});

test("15. byte-exactness: special chars in a finding survive verbatim into the sticky", () => {
  const tricky = "use `??` not `||` — pipe | and > arrow, and it's fine";
  const comments = [
    mk("SECURITY", { verdict: "ship", blocking_count: 0, advisory_count: 1, sensitive_paths_touched: false, top_issues: [{ file: "a.ts", line: 5, severity: "advisory", summary: tricky }] }),
    mk("ARCHITECTURE", ship()),
    mk("CORRECTNESS", ship({ ci_failing: false })),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.ok(r.stickyBody.includes(tricky), "the finding text must survive byte-for-byte");
  assert.ok(r.stickyBody.includes("`a.ts:5`"), "file:line code span rendered");
  assert.match(r.stickyBody, /<!-- KUZO-VERDICT-STICKY -->/);
});

test("16. tier shape: standard vs deep markers/sections differ", () => {
  const std = aggregate({ comments: [mk("SECURITY", ship()), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))], prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.match(std.stickyBody, /<!-- KUZO-VERDICT-STICKY -->/);
  assert.match(std.stickyBody, /### Specialists\n/);
  assert.match(std.stickyBody, /\*\*CI\*\*:/);
});

test("17. empty comments → all lanes degraded, fix-then-ship, no throw", () => {
  const r = aggregate({ comments: [], prMeta: {}, laneResults: {}, tier: "standard" });
  assert.equal(r.degraded, true);
  assert.equal(r.verdict, "fix-then-ship");
  assert.equal(r.round, 1);
  assert.equal(r.escalate, false);
  assert.equal(r.headSha, null);
});

test("18. extractSentinel handles compact, spaced, and multi-line JSON", () => {
  const compact = { id: 1, created_at: ts(), body: '<!-- KUZO-REVIEW-JSON-SECURITY\n{"verdict":"ship","blocking_count":0}\n-->' };
  const spaced = { id: 2, created_at: ts(), body: '<!-- KUZO-REVIEW-JSON-SECURITY\n{ "verdict": "ship", "blocking_count": 0 }\n-->' };
  const multiline = { id: 3, created_at: ts(), body: '<!-- KUZO-REVIEW-JSON-SECURITY\n{\n  "verdict": "rethink",\n  "blocking_count": 1\n}\n-->' };
  assert.equal(extractSentinel([compact], "SECURITY", "standard").sentinel.verdict, "ship");
  assert.equal(extractSentinel([spaced], "SECURITY", "standard").sentinel.verdict, "ship");
  assert.equal(extractSentinel([multiline], "SECURITY", "standard").sentinel.verdict, "rethink");
});

test("19. replay real PR #57 comments → round 4 (final), clean ship, cap banner, no escalation", () => {
  const comments = JSON.parse(readFileSync(join(here, "fixtures", "pr57-comments.json"), "utf8"));
  const r = aggregate({ comments, prMeta: { additions: 120, deletions: 30, labels: [], headRefOid: "ebfe590000000000000000000000000000000000" }, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.round, 4, "existing sticky was round 3 → this is round 4");
  assert.equal(r.capReached, true);
  assert.equal(r.degraded, false, "all three lanes posted sentinels");
  assert.equal(r.totalBlocking, 0);
  assert.equal(r.verdict, "ship", "clean final round stays ship");
  assert.equal(r.escalate, false);
  for (const id of ["security", "architecture", "correctness"]) {
    assert.equal(r.lanes.find((l) => l.id === id).present, true, id + " sentinel parsed");
  }
  assert.match(r.stickyBody, /<!-- VERDICT_ROUND: 4 -->/);
  assert.match(r.stickyBody, /4-round cap reached/);
});

test("20. lane posted a valid sentinel but its JOB failed → trusted, noted, not degraded", () => {
  const comments = [mk("SECURITY", ship({ advisory_count: 1 })), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))];
  const r = aggregate({ comments, prMeta: META, laneResults: { security: "failure", architecture: "success", correctness: "success" }, tier: "standard" });
  const sec = r.lanes.find((l) => l.id === "security");
  assert.equal(sec.present, true, "a valid sentinel is trusted even when the job result is failure");
  assert.equal(sec.jobOk, false);
  assert.equal(sec.note, "job: failure");
  assert.equal(r.degraded, false);
  assert.equal(r.verdict, "ship", "a posted-then-crashed lane does not block a clean verdict");
  assert.match(r.stickyBody, /Security: ship .* — ⚠️ job: failure/);
});

test("21. present sentinel with an out-of-enum (or missing) verdict → degraded, never ship", () => {
  const garbage = aggregate({
    comments: [mk("SECURITY", { verdict: "lgtm", blocking_count: 0, advisory_count: 0, sensitive_paths_touched: false }), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))],
    prMeta: META, laneResults: ALL_OK, tier: "standard",
  });
  const sec = garbage.lanes.find((l) => l.id === "security");
  assert.equal(sec.present, false, "a non-enum verdict is not a usable lane result");
  assert.equal(sec.reason, "no-verdict");
  assert.equal(garbage.degraded, true);
  assert.notEqual(garbage.verdict, "ship");
  const missing = aggregate({
    comments: [mk("SECURITY", { blocking_count: 0, advisory_count: 1, sensitive_paths_touched: false }), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))],
    prMeta: META, laneResults: ALL_OK, tier: "standard",
  });
  assert.equal(missing.lanes.find((l) => l.id === "security").reason, "no-verdict");
  assert.notEqual(missing.verdict, "ship");
});

test("22. headSha validated: invalid OIDs → null + no marker; 7- and 64-char hex accepted", () => {
  const comments = [mk("SECURITY", ship()), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))];
  for (const bad of ["ABCDEF1", "abcdef", "g123456", "abc 123", "a".repeat(65), ""]) {
    const r = aggregate({ comments, prMeta: { ...META, headRefOid: bad }, laneResults: ALL_OK, tier: "standard" });
    assert.equal(r.headSha, null, "must reject " + JSON.stringify(bad));
    assert.doesNotMatch(r.stickyBody, /VERDICT_HEAD_SHA/);
  }
  for (const good of ["a".repeat(7), "a".repeat(64)]) {
    const r = aggregate({ comments, prMeta: { ...META, headRefOid: good }, laneResults: ALL_OK, tier: "standard" });
    assert.equal(r.headSha, good);
    assert.match(r.stickyBody, /<!-- VERDICT_HEAD_SHA: a+ -->/);
  }
});

test("23. label idempotency: already-present → escalate true but applyLabel false (string + object forms)", () => {
  const comments = [
    mk("SECURITY", { verdict: "rethink", blocking_count: 1, advisory_count: 0, sensitive_paths_touched: false }),
    mk("ARCHITECTURE", ship()),
    mk("CORRECTNESS", ship({ ci_failing: false })),
  ];
  for (const labels of [["claude-deep-review"], [{ name: "claude-deep-review" }]]) {
    const r = aggregate({ comments, prMeta: { ...META, labels }, laneResults: ALL_OK, tier: "standard" });
    assert.equal(r.escalate, true);
    assert.equal(r.labelAlreadyPresent, true);
    assert.equal(r.applyLabel, false);
  }
});

test("24. deep-tier round increment + cap from a DEEP_VERDICT_ROUND sticky", () => {
  const deepSentinels = [
    mk("SECURITY", { ...ship(), tier: "deep" }, "2026-01-01T00:00:02Z"),
    mk("ARCHITECTURE", { ...ship(), tier: "deep" }, "2026-01-01T00:00:03Z"),
    mk("CORRECTNESS", { ...ship({ ci_failing: false }), tier: "deep" }, "2026-01-01T00:00:04Z"),
    mk("THREATMODEL", { verdict: "ship", blocking_count: 0, advisory_count: 0, sensitive_paths_touched: false, threats: [], tier: "deep" }, "2026-01-01T00:00:05Z"),
  ];
  const r = aggregate({ comments: [sticky(3, "deep", "2026-01-01T00:00:01Z"), ...deepSentinels], prMeta: META, laneResults: ALL_OK_DEEP, tier: "deep" });
  assert.equal(r.round, 4);
  assert.equal(r.capReached, true);
  assert.match(r.stickyBody, /<!-- DEEP_VERDICT_ROUND: 4 -->/);
  assert.match(r.stickyBody, /4-round cap reached/);
});

test("25. existingStickyId reflects the prior sticky (drives PATCH vs POST in main)", () => {
  const s = sticky(1);
  const withSticky = aggregate({ comments: [s, mk("SECURITY", ship()), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))], prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(withSticky.existingStickyId, s.id);
  const without = aggregate({ comments: [mk("SECURITY", ship()), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))], prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(without.existingStickyId, null);
});

test("26. num() coercion: string→int, float→floor, negative/NaN→0", () => {
  const comments = [
    mk("SECURITY", { verdict: "fix-then-ship", blocking_count: "3", advisory_count: 2.9, sensitive_paths_touched: false }),
    mk("ARCHITECTURE", { verdict: "fix-then-ship", blocking_count: -5, advisory_count: "x", sensitive_paths_touched: false }),
    mk("CORRECTNESS", ship({ ci_failing: false })),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.totalBlocking, 3, "'3' → 3, -5 → 0");
  assert.equal(r.totalAdvisory, 2, "2.9 → 2, 'x' → 0");
});

test("27. round-3 boundary: round-2 sticky → round 3, cap NOT reached, verdict not forced", () => {
  const comments = [sticky(2, "standard", "2026-01-01T00:00:01Z"), mk("SECURITY", ship(), "2026-01-01T00:00:02Z"), mk("ARCHITECTURE", ship(), "2026-01-01T00:00:03Z"), mk("CORRECTNESS", ship({ ci_failing: false }), "2026-01-01T00:00:04Z")];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.round, 3);
  assert.equal(r.capReached, false);
  assert.equal(r.verdict, "ship");
  assert.doesNotMatch(r.stickyBody, /4-round cap reached/);
});

test("28. action items: blocking listed before advisory across lanes, capped at 5 (standard)", () => {
  const issues = (sev, n, prefix) => Array.from({ length: n }, (_, i) => ({ file: prefix + i + ".ts", line: i + 1, severity: sev, summary: prefix + " " + i }));
  const comments = [
    mk("SECURITY", { verdict: "ship", blocking_count: 0, advisory_count: 3, sensitive_paths_touched: false, top_issues: issues("advisory", 3, "sec-adv") }),
    mk("ARCHITECTURE", { verdict: "fix-then-ship", blocking_count: 4, advisory_count: 0, sensitive_paths_touched: false, top_issues: issues("blocking", 4, "arch-blk") }),
    mk("CORRECTNESS", ship({ ci_failing: false })),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  const items = r.stickyBody.split("\n").filter((l) => l.startsWith("- [ ] "));
  assert.equal(items.length, 5, "capped at 5");
  assert.ok(items.slice(0, 4).every((l) => l.includes("arch-blk")), "all blocking items first");
  assert.ok(items[4].includes("sec-adv"), "advisory only after blocking");
});

test("29. deep threats capped at 7", () => {
  const threats = Array.from({ length: 12 }, (_, i) => ({ category: "S", severity: "advisory", summary: "threat " + i }));
  const comments = [
    mk("SECURITY", { ...ship(), tier: "deep" }),
    mk("ARCHITECTURE", { ...ship(), tier: "deep" }),
    mk("CORRECTNESS", { ...ship({ ci_failing: false }), tier: "deep" }),
    mk("THREATMODEL", { verdict: "ship", blocking_count: 0, advisory_count: 0, sensitive_paths_touched: false, threats, tier: "deep" }),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK_DEEP, tier: "deep" });
  const lines = r.stickyBody.split("\n").filter((l) => /^- S: threat /.test(l));
  assert.equal(lines.length, 7);
});

test("30. ciFailing is null (CI unknown) when the correctness lane is degraded", () => {
  const comments = [mk("SECURITY", ship()), mk("ARCHITECTURE", ship())]; // no correctness sentinel
  const r = aggregate({ comments, prMeta: META, laneResults: { security: "success", architecture: "success", correctness: "failure" }, tier: "standard" });
  assert.equal(r.lanes.find((l) => l.id === "correctness").present, false);
  assert.equal(r.ciFailing, null);
  assert.match(r.stickyBody, /\*\*CI\*\*: unknown/);
});

test("31. deep tier falls back to untagged sentinels when none carry tier:deep", () => {
  const comments = [
    mk("SECURITY", ship()),
    mk("ARCHITECTURE", ship()),
    mk("CORRECTNESS", ship({ ci_failing: false })),
    mk("THREATMODEL", { verdict: "ship", blocking_count: 0, advisory_count: 0, sensitive_paths_touched: false, threats: [] }),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK_DEEP, tier: "deep" });
  assert.equal(r.degraded, false, "all 4 lanes resolve from untagged sentinels");
  assert.equal(r.verdict, "ship");
});

test("32. stale-but-valid wins when a newer same-lane sentinel is malformed", () => {
  const comments = [
    mk("SECURITY", ship(), "2026-01-01T00:00:01Z"),
    { id: 9001, created_at: "2026-01-01T00:00:09Z", body: "<!-- KUZO-REVIEW-JSON-SECURITY\n{ not valid json }\n-->" },
    mk("ARCHITECTURE", ship(), "2026-01-01T00:00:02Z"),
    mk("CORRECTNESS", ship({ ci_failing: false }), "2026-01-01T00:00:03Z"),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  const sec = r.lanes.find((l) => l.id === "security");
  assert.equal(sec.present, true, "the older valid sentinel survives a newer malformed one");
  assert.equal(sec.verdict, "ship");
});

test("33. two sentinel blocks in one comment → the last block wins", () => {
  const body =
    '<!-- KUZO-REVIEW-JSON-SECURITY\n{"verdict":"ship","blocking_count":0}\n-->\nmid\n' +
    '<!-- KUZO-REVIEW-JSON-SECURITY\n{"verdict":"rethink","blocking_count":2}\n-->';
  const comments = [{ id: 9100, created_at: ts(), body }, mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.lanes.find((l) => l.id === "security").verdict, "rethink");
});

test("34. standard escalation banner is honest about manual Tier-3 dispatch", () => {
  const comments = [
    mk("SECURITY", { verdict: "rethink", blocking_count: 1, advisory_count: 0, sensitive_paths_touched: false }),
    mk("ARCHITECTURE", ship()),
    mk("CORRECTNESS", ship({ ci_failing: false })),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.match(r.stickyBody, /Escalation criteria met/);
  assert.match(r.stickyBody, /does NOT auto-trigger Tier 3/);
  assert.match(r.stickyBody, /reason: rethink-verdict/);
});
