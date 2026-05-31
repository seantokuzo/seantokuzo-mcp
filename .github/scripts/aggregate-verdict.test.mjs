#!/usr/bin/env node
/**
 * .github/scripts/aggregate-verdict.test.mjs
 *
 * Unit tests for the deterministic verdict aggregator. Pure — exercises the
 * exported aggregate()/extractSentinel()/findExistingSticky() with synthetic
 * line-format sentinel comments.
 *
 * Run: node --test .github/scripts/*.test.mjs   (no deps, no build, no pnpm)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { aggregate, extractSentinel, findExistingSticky } from "./aggregate-verdict.mjs";

// --- fixture helpers ------------------------------------------------------

let _id = 1000;
let _t = 0;
function ts() {
  _t += 1;
  return "2026-01-01T00:00:" + String(_t).padStart(2, "0") + "Z";
}

/** Render a line-format sentinel comment for a lane from a structured object. */
function mk(laneKey, obj, at = ts()) {
  const lines = [];
  if (obj.verdict !== undefined) lines.push("verdict: " + obj.verdict);
  if (obj.blocking_count !== undefined) lines.push("blocking: " + obj.blocking_count);
  if (obj.advisory_count !== undefined) lines.push("advisory: " + obj.advisory_count);
  if (obj.sensitive_paths_touched !== undefined) lines.push("sensitive: " + obj.sensitive_paths_touched);
  if (obj.ci_failing !== undefined) lines.push("ci_failing: " + obj.ci_failing);
  if (obj.tier !== undefined) lines.push("tier: " + obj.tier);
  if (Array.isArray(obj.threats)) for (const th of obj.threats) lines.push("threat: " + th.category + " | " + th.summary);
  const sentinel = "<!-- KUZO-REVIEW-" + laneKey + "\n" + lines.join("\n") + "\n-->";
  return { id: _id++, created_at: at, body: sentinel + "\n\n## " + laneKey + " Review\n\nfindings" };
}
/** A bare sentinel comment from a raw body string (for malformed/edge cases). */
function raw(body, at = ts()) {
  return { id: _id++, created_at: at, body };
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
const META = { additions: 10, deletions: 5, headRefOid: "abc1234def5678", number: 99 };
const ALL_OK = { security: "success", architecture: "success", correctness: "success" };
const ALL_OK_DEEP = { ...ALL_OK, threatmodel: "success" };
function ship(extra = {}) {
  return { verdict: "ship", blocking_count: 0, advisory_count: 0, sensitive_paths_touched: false, ...extra };
}
const TRIO = () => [mk("SECURITY", ship()), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))];

// --- tests ----------------------------------------------------------------

test("1. all lanes ship, round 1 → ship, no escalation, head sha marker", () => {
  const comments = [mk("SECURITY", ship({ advisory_count: 1 })), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.verdict, "ship");
  assert.equal(r.round, 1);
  assert.equal(r.escalate, false);
  assert.equal(r.degraded, false);
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
  assert.equal(six.escalate, true);
  assert.equal(six.escalateReason, ">5-blocking");
});

test("5. large-diff escalation boundary: 500 no, 501 yes (verdict still ship)", () => {
  const at500 = aggregate({ comments: TRIO(), prMeta: { ...META, additions: 300, deletions: 200 }, laneResults: ALL_OK, tier: "standard" });
  assert.equal(at500.verdict, "ship");
  assert.equal(at500.escalate, false);
  const at501 = aggregate({ comments: TRIO(), prMeta: { ...META, additions: 301, deletions: 200 }, laneResults: ALL_OK, tier: "standard" });
  assert.equal(at501.escalate, true);
  assert.equal(at501.escalateReason, "large-diff");
});

test("6. sensitive paths: alone no escalate, +blocking escalates", () => {
  const a = aggregate({
    comments: [mk("SECURITY", ship({ sensitive_paths_touched: true })), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))],
    prMeta: META, laneResults: ALL_OK, tier: "standard",
  });
  assert.equal(a.sensitivePaths, true);
  assert.equal(a.escalate, false);
  const b = aggregate({
    comments: [mk("SECURITY", { verdict: "fix-then-ship", blocking_count: 1, advisory_count: 0, sensitive_paths_touched: true }), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))],
    prMeta: META, laneResults: ALL_OK, tier: "standard",
  });
  assert.equal(b.escalate, true);
  assert.equal(b.escalateReason, "sensitive-paths-with-blocking");
});

test("7. round parsing: none→1, sticky:2→3, sticky-without-round→2", () => {
  assert.equal(aggregate({ comments: TRIO(), prMeta: META, laneResults: ALL_OK, tier: "standard" }).round, 1);
  assert.equal(findExistingSticky([sticky(2)], "standard").round, 3);
  const noRound = raw("<!-- KUZO-VERDICT-STICKY -->\n\n## Verdict (round marker missing)");
  assert.equal(findExistingSticky([noRound], "standard").round, 2);
});

test("8. cap: round 4 is final (banner, NOT forced, escalation suppressed); round 5 forces rethink", () => {
  const round4 = aggregate({
    comments: [sticky(3, "standard", "2026-01-01T00:00:01Z"), mk("SECURITY", ship(), "2026-01-01T00:00:02Z"), mk("ARCHITECTURE", ship(), "2026-01-01T00:00:03Z"), mk("CORRECTNESS", ship({ ci_failing: false }), "2026-01-01T00:00:04Z")],
    prMeta: { ...META, additions: 9000, deletions: 9000 },
    laneResults: ALL_OK, tier: "standard",
  });
  assert.equal(round4.round, 4);
  assert.equal(round4.capReached, true);
  assert.equal(round4.verdict, "ship", "clean round 4 stays ship");
  assert.equal(round4.escalate, false, "escalation suppressed at the cap");
  assert.match(round4.stickyBody, /4-round cap reached/);

  const round5 = aggregate({
    comments: [sticky(4, "standard", "2026-01-01T00:00:01Z"), mk("SECURITY", ship(), "2026-01-01T00:00:02Z"), mk("ARCHITECTURE", ship(), "2026-01-01T00:00:03Z"), mk("CORRECTNESS", ship({ ci_failing: false }), "2026-01-01T00:00:04Z")],
    prMeta: META, laneResults: ALL_OK, tier: "standard",
  });
  assert.equal(round5.round, 5);
  assert.equal(round5.verdict, "rethink", "over-cap forces rethink");
  assert.equal(round5.escalate, false);
});

test("9a. missing lane (job-failed, no sentinel) → degraded, never ship, no escalate", () => {
  const comments = [mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))];
  const r = aggregate({ comments, prMeta: META, laneResults: { security: "failure", architecture: "success", correctness: "success" }, tier: "standard" });
  assert.equal(r.degraded, true);
  assert.equal(r.verdict, "fix-then-ship");
  assert.equal(r.escalate, false);
  const sec = r.lanes.find((l) => l.id === "security");
  assert.equal(sec.present, false);
  assert.equal(sec.reason, "job-failed");
  assert.match(r.stickyBody, /no verdict \(job-failed\)/);
});

test("9b. job ok, no sentinel posted → reason no-sentinel", () => {
  const r = aggregate({ comments: [mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))], prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.lanes.find((l) => l.id === "security").reason, "no-sentinel");
});

test("9c. marker present but no key:value lines → malformed-sentinel, no throw", () => {
  const bad = raw("<!-- KUZO-REVIEW-SECURITY\n(this lane crashed before emitting fields)\n-->");
  const r = aggregate({ comments: [bad, mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))], prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.lanes.find((l) => l.id === "security").reason, "malformed-sentinel");
});

test("10. most-recent sentinel wins across rounds", () => {
  const comments = [
    mk("SECURITY", ship(), "2026-01-01T00:00:01Z"),
    mk("ARCHITECTURE", ship(), "2026-01-01T00:00:02Z"),
    mk("CORRECTNESS", ship({ ci_failing: false }), "2026-01-01T00:00:03Z"),
    mk("SECURITY", { verdict: "rethink", blocking_count: 1, advisory_count: 0, sensitive_paths_touched: false }, "2026-01-01T00:00:10Z"),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.lanes.find((l) => l.id === "security").verdict, "rethink");
  assert.equal(r.verdict, "rethink");
});

test("11. deep-tier precedence: deep sentinel beats a chronologically-newer Tier-2 one", () => {
  const comments = [
    mk("SECURITY", { ...ship(), tier: "deep" }, "2026-01-01T00:00:01Z"),
    mk("SECURITY", { verdict: "rethink", blocking_count: 2, advisory_count: 0, sensitive_paths_touched: false }, "2026-01-01T00:00:09Z"),
    mk("ARCHITECTURE", { ...ship(), tier: "deep" }),
    mk("CORRECTNESS", { ...ship({ ci_failing: false }), tier: "deep" }),
    mk("THREATMODEL", { verdict: "ship", blocking_count: 0, advisory_count: 0, sensitive_paths_touched: false, tier: "deep" }),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK_DEEP, tier: "deep" });
  assert.equal(r.lanes.find((l) => l.id === "security").verdict, "ship");
  assert.equal(r.verdict, "ship");
});

test("12. self-poisoning guard: a sticky quoting a sentinel marker is not parsed", () => {
  const poison = raw("<!-- KUZO-VERDICT-STICKY -->\n<!-- VERDICT_ROUND: 1 -->\n\nExample: <!-- KUZO-REVIEW-SECURITY verdict: ship -->");
  const r = aggregate({ comments: [poison, mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))], prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.lanes.find((l) => l.id === "security").present, false);
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

test("14. deep tier: threat lines render, no CI line, no escalation block", () => {
  const comments = [
    mk("SECURITY", { ...ship({ sensitive_paths_touched: true }), tier: "deep" }),
    mk("ARCHITECTURE", { ...ship(), tier: "deep" }),
    mk("CORRECTNESS", { ...ship({ ci_failing: false }), tier: "deep" }),
    mk("THREATMODEL", { verdict: "ship", blocking_count: 0, advisory_count: 1, sensitive_paths_touched: true, tier: "deep", threats: [{ category: "S", summary: "token confusion possible" }] }),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK_DEEP, tier: "deep" });
  assert.equal(r.lanes.length, 4);
  assert.match(r.stickyBody, /<!-- KUZO-DEEP-VERDICT-STICKY -->/);
  assert.match(r.stickyBody, /Specialists \(deep mode\)/);
  assert.match(r.stickyBody, /### Top threats/);
  assert.match(r.stickyBody, /- S: token confusion possible/);
  assert.doesNotMatch(r.stickyBody, /\*\*CI\*\*/);
  assert.doesNotMatch(r.stickyBody, /Escalation criteria met/);
});

test("15. sticky byte-exactness: markers present and `|` survives in the output", () => {
  const r = aggregate({ comments: TRIO(), prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.match(r.stickyBody, /<!-- KUZO-VERDICT-STICKY -->/);
  assert.match(r.stickyBody, /<!-- VERDICT_ROUND: 1 -->/);
  assert.ok(r.stickyBody.includes("**Blocking**: 0 | **Advisory**: 0"), "the `|` survives verbatim");
});

test("16. tier shape: standard has CI line + standard markers", () => {
  const std = aggregate({ comments: TRIO(), prMeta: META, laneResults: ALL_OK, tier: "standard" });
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

test("18. line parsing: whitespace-tolerant keys/values, extra keys ignored, missing fields default", () => {
  const sec = extractSentinel([raw("<!-- KUZO-REVIEW-SECURITY\n   verdict :   ship  \nblocking:0\nrationale: looks fine\n-->")], "SECURITY", "standard").sentinel;
  assert.equal(sec.verdict, "ship");
  assert.equal(sec.blocking, "0");
  assert.equal(sec.rationale, "looks fine");
  // a present-but-no-advisory sentinel still aggregates with advisory defaulting to 0
  const r = aggregate({ comments: [raw("<!-- KUZO-REVIEW-SECURITY\nverdict: ship\nblocking: 0\n-->"), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))], prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.lanes.find((l) => l.id === "security").advisory, 0);
});

test("19. multi-round line-format: round-3 sticky + fresh ship sentinels → round 4, cap, ship", () => {
  const comments = [
    sticky(1, "standard", "2026-01-01T00:00:01Z"),
    sticky(2, "standard", "2026-01-01T00:00:05Z"),
    sticky(3, "standard", "2026-01-01T00:00:09Z"),
    mk("SECURITY", ship(), "2026-01-01T00:00:11Z"),
    mk("ARCHITECTURE", ship(), "2026-01-01T00:00:12Z"),
    mk("CORRECTNESS", ship({ ci_failing: false }), "2026-01-01T00:00:13Z"),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.round, 4, "latest sticky was round 3 → this is round 4");
  assert.equal(r.capReached, true);
  assert.equal(r.degraded, false);
  assert.equal(r.verdict, "ship");
  assert.match(r.stickyBody, /<!-- VERDICT_ROUND: 4 -->/);
  assert.match(r.stickyBody, /4-round cap reached/);
});

test("20. lane posted a valid sentinel but its JOB failed → trusted, noted, not degraded", () => {
  const r = aggregate({ comments: TRIO(), prMeta: META, laneResults: { security: "failure", architecture: "success", correctness: "success" }, tier: "standard" });
  const sec = r.lanes.find((l) => l.id === "security");
  assert.equal(sec.present, true, "valid sentinel trusted even when the job result is failure");
  assert.equal(sec.jobOk, false);
  assert.equal(sec.note, "job: failure");
  assert.equal(r.degraded, false);
  assert.equal(r.verdict, "ship");
  assert.match(r.stickyBody, /Security: ship .* — ⚠️ job: failure/);
});

test("21. present sentinel with an out-of-enum (or missing) verdict → degraded, never ship", () => {
  const garbage = aggregate({ comments: [mk("SECURITY", { verdict: "lgtm", blocking_count: 0, advisory_count: 0, sensitive_paths_touched: false }), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))], prMeta: META, laneResults: ALL_OK, tier: "standard" });
  const sec = garbage.lanes.find((l) => l.id === "security");
  assert.equal(sec.present, false);
  assert.equal(sec.reason, "no-verdict");
  assert.notEqual(garbage.verdict, "ship");
  const missing = aggregate({ comments: [raw("<!-- KUZO-REVIEW-SECURITY\nblocking: 0\nadvisory: 1\n-->"), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))], prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(missing.lanes.find((l) => l.id === "security").reason, "no-verdict");
  assert.notEqual(missing.verdict, "ship");
});

test("22. headSha validated: invalid OIDs → null + no marker; 7- and 64-char hex accepted", () => {
  for (const bad of ["ABCDEF1", "abcdef", "g123456", "abc 123", "a".repeat(65), ""]) {
    const r = aggregate({ comments: TRIO(), prMeta: { ...META, headRefOid: bad }, laneResults: ALL_OK, tier: "standard" });
    assert.equal(r.headSha, null, "must reject " + JSON.stringify(bad));
    assert.doesNotMatch(r.stickyBody, /VERDICT_HEAD_SHA/);
  }
  for (const good of ["a".repeat(7), "a".repeat(64)]) {
    const r = aggregate({ comments: TRIO(), prMeta: { ...META, headRefOid: good }, laneResults: ALL_OK, tier: "standard" });
    assert.equal(r.headSha, good);
    assert.match(r.stickyBody, /<!-- VERDICT_HEAD_SHA: a+ -->/);
  }
});

test("23. deep-tier round increment + cap from a DEEP_VERDICT_ROUND sticky", () => {
  const deep = [
    mk("SECURITY", { ...ship(), tier: "deep" }, "2026-01-01T00:00:02Z"),
    mk("ARCHITECTURE", { ...ship(), tier: "deep" }, "2026-01-01T00:00:03Z"),
    mk("CORRECTNESS", { ...ship({ ci_failing: false }), tier: "deep" }, "2026-01-01T00:00:04Z"),
    mk("THREATMODEL", { verdict: "ship", blocking_count: 0, advisory_count: 0, sensitive_paths_touched: false, tier: "deep" }, "2026-01-01T00:00:05Z"),
  ];
  const r = aggregate({ comments: [sticky(3, "deep", "2026-01-01T00:00:01Z"), ...deep], prMeta: META, laneResults: ALL_OK_DEEP, tier: "deep" });
  assert.equal(r.round, 4);
  assert.equal(r.capReached, true);
  assert.match(r.stickyBody, /<!-- DEEP_VERDICT_ROUND: 4 -->/);
});

test("24. existingStickyId reflects the prior sticky (drives PATCH vs POST in main)", () => {
  const s = sticky(1);
  const withSticky = aggregate({ comments: [s, ...TRIO()], prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(withSticky.existingStickyId, s.id);
  const without = aggregate({ comments: TRIO(), prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(without.existingStickyId, null);
});

test("25. num() coercion: string→int, float→floor, negative/NaN→0", () => {
  const comments = [
    mk("SECURITY", { verdict: "fix-then-ship", blocking_count: "3", advisory_count: "2", sensitive_paths_touched: false }),
    mk("ARCHITECTURE", { verdict: "fix-then-ship", blocking_count: "-5", advisory_count: "x", sensitive_paths_touched: false }),
    mk("CORRECTNESS", ship({ ci_failing: false })),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.totalBlocking, 3, "'3' → 3, '-5' → 0");
  assert.equal(r.totalAdvisory, 2, "'2' → 2, 'x' → 0");
});

test("26. round-3 boundary: round-2 sticky → round 3, cap NOT reached, verdict not forced", () => {
  const comments = [sticky(2, "standard", "2026-01-01T00:00:01Z"), mk("SECURITY", ship(), "2026-01-01T00:00:02Z"), mk("ARCHITECTURE", ship(), "2026-01-01T00:00:03Z"), mk("CORRECTNESS", ship({ ci_failing: false }), "2026-01-01T00:00:04Z")];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.round, 3);
  assert.equal(r.capReached, false);
  assert.equal(r.verdict, "ship");
  assert.doesNotMatch(r.stickyBody, /4-round cap reached/);
});

test("27. deep threats capped at 7", () => {
  const threats = Array.from({ length: 12 }, (_, i) => ({ category: "S", summary: "threat " + i }));
  const comments = [
    mk("SECURITY", { ...ship(), tier: "deep" }),
    mk("ARCHITECTURE", { ...ship(), tier: "deep" }),
    mk("CORRECTNESS", { ...ship({ ci_failing: false }), tier: "deep" }),
    mk("THREATMODEL", { verdict: "ship", blocking_count: 0, advisory_count: 0, sensitive_paths_touched: false, tier: "deep", threats }),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK_DEEP, tier: "deep" });
  const lines = r.stickyBody.split("\n").filter((l) => /^- S: threat /.test(l));
  assert.equal(lines.length, 7);
});

test("28. ciFailing is null (CI unknown) when the correctness lane is degraded", () => {
  const r = aggregate({ comments: [mk("SECURITY", ship()), mk("ARCHITECTURE", ship())], prMeta: META, laneResults: { security: "success", architecture: "success", correctness: "failure" }, tier: "standard" });
  assert.equal(r.lanes.find((l) => l.id === "correctness").present, false);
  assert.equal(r.ciFailing, null);
  assert.match(r.stickyBody, /\*\*CI\*\*: unknown/);
});

test("29. deep tier falls back to untagged sentinels when none carry tier:deep", () => {
  const comments = [
    mk("SECURITY", ship()),
    mk("ARCHITECTURE", ship()),
    mk("CORRECTNESS", ship({ ci_failing: false })),
    mk("THREATMODEL", { verdict: "ship", blocking_count: 0, advisory_count: 0, sensitive_paths_touched: false }),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK_DEEP, tier: "deep" });
  assert.equal(r.degraded, false);
  assert.equal(r.verdict, "ship");
});

test("30. stale-but-valid wins when a newer same-lane sentinel is malformed", () => {
  const comments = [
    mk("SECURITY", ship(), "2026-01-01T00:00:01Z"),
    raw("<!-- KUZO-REVIEW-SECURITY\n(crashed mid-emit)\n-->", "2026-01-01T00:00:09Z"),
    mk("ARCHITECTURE", ship(), "2026-01-01T00:00:02Z"),
    mk("CORRECTNESS", ship({ ci_failing: false }), "2026-01-01T00:00:03Z"),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  const sec = r.lanes.find((l) => l.id === "security");
  assert.equal(sec.present, true);
  assert.equal(sec.verdict, "ship");
});

test("31. two sentinel blocks in one comment → the last block wins", () => {
  const body =
    "<!-- KUZO-REVIEW-SECURITY\nverdict: ship\nblocking: 0\n-->\nmid\n" +
    "<!-- KUZO-REVIEW-SECURITY\nverdict: rethink\nblocking: 2\n-->";
  const r = aggregate({ comments: [raw(body), mk("ARCHITECTURE", ship()), mk("CORRECTNESS", ship({ ci_failing: false }))], prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.lanes.find((l) => l.id === "security").verdict, "rethink");
});

test("32. escalation is a RECOMMENDATION (no label), with a manual dispatch hint", () => {
  const comments = [
    mk("SECURITY", { verdict: "rethink", blocking_count: 1, advisory_count: 0, sensitive_paths_touched: false }),
    mk("ARCHITECTURE", ship()),
    mk("CORRECTNESS", ship({ ci_failing: false })),
  ];
  const r = aggregate({ comments, prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.escalate, true);
  assert.equal(r.applyLabel, undefined, "no label is applied under the dispatch-only model");
  assert.match(r.stickyBody, /Escalation criteria met \(reason: rethink-verdict\)/);
  assert.match(r.stickyBody, /gh workflow run claude-deep-review\.yml -f pr_number=99/);
});

test("33. sentinel marker boundary: no cross-lane bleed, no prefix mis-match", () => {
  // cross-lane: an ARCHITECTURE sentinel must not be read as SECURITY
  const r = aggregate({ comments: [raw("<!-- KUZO-REVIEW-ARCHITECTURE\nverdict: ship\nblocking: 0\n-->"), mk("CORRECTNESS", ship({ ci_failing: false }))], prMeta: META, laneResults: ALL_OK, tier: "standard" });
  assert.equal(r.lanes.find((l) => l.id === "architecture").present, true);
  assert.equal(r.lanes.find((l) => l.id === "security").present, false);
  // a longer marker with SECURITY as a prefix must NOT match the SECURITY lane
  assert.equal(extractSentinel([raw("<!-- KUZO-REVIEW-SECURITYEXTRA\nverdict: ship\n-->")], "SECURITY", "standard").sentinel, null);
});
