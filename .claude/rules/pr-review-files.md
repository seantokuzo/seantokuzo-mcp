---
paths:
  - ".github/workflows/claude*.yml"
  - ".github/instructions/pr-review.instructions.md"
  - ".github/instructions/workflow.instructions.md"
---

# PR Review System — Quick Reference

When you're touching review workflows or instructions, remember the surface.

## Tiers (all READ-ONLY — `Edit`/`Write`/`NotebookEdit` disallowed)

| Tier | Workflow | Trigger | Model | Effort |
|------|----------|---------|-------|--------|
| 1 | `claude.yml` | `@claude` mentions, `workflow_dispatch` | Opus 4.6 | `max` |
| 2 | `claude-code-review.yml` | **`workflow_dispatch` only** (no auto-fire) | Opus 4.7 | `xhigh` |
| 3 | `claude-deep-review.yml` | **`workflow_dispatch` only** (no auto-fire) | Opus 4.7 | `max`, 150 turns |

**DISPATCH-ONLY model:** neither tier auto-fires. Claude Code (the orchestrator) decides per PR which review to run and dispatches it, so trivial PRs cost zero Opus. **Policy: functional code changes get a `normal` (Tier 2) review by default; skip (`none`) only for non-functional changes (docs, state files, config).** Dispatch:
- normal: `gh workflow run claude-code-review.yml -f pr_number=<N> [-f specialist=all|security|architecture|correctness]`
- deep: `gh workflow run claude-deep-review.yml -f pr_number=<N>`

## Sentinels (LINE format — NOT JSON)

Specialists emit a brace/quote-free sentinel as a **dedicated** comment (the
sandbox Bash validator blocks `{` adjacent to `"`, so JSON cannot post):

```html
<!-- KUZO-REVIEW-{SECURITY|ARCHITECTURE|CORRECTNESS|THREATMODEL}
verdict: ship | fix-then-ship | rethink
blocking: <N>
advisory: <N>
sensitive: true | false
ci_failing: true | false        (correctness only)
tier: deep                      (deep review only)
threat: <S|T|R|I|D|E> | <summary>   (threat-model only, repeatable)
-->
```

The aggregator scans both issue comments and inline (pulls) review comments, so
a sentinel posted via the validator-immune MCP inline tool is still found. Why
line format: memory `feedback_sentinel_emission_brace_quote`.

## Verdict (deterministic, not an LLM)

The verdict sticky is computed by **`.github/scripts/aggregate-verdict.mjs`** — a plain Node `run:` step (PR #60), NOT an LLM. It parses the specialist sentinels, computes verdict/counts/round/escalation as code, and posts via `gh api --input -` (body as JSON on stdin → no shell parses it). Unit-tested in `.github/scripts/aggregate-verdict.test.mjs`, gated on `ci-success`.

## Stickies

- Tier 2: `<!-- KUZO-VERDICT-STICKY -->` + `<!-- VERDICT_ROUND: N -->` + `<!-- VERDICT_HEAD_SHA: <sha> -->`
- Tier 3: `<!-- KUZO-DEEP-VERDICT-STICKY -->` + `<!-- DEEP_VERDICT_ROUND: N -->` + `<!-- VERDICT_HEAD_SHA: <sha> -->`

The sticky's `VERDICT_HEAD_SHA` matching the PR head is the round-completion signal.

## Hard rules

- **4 rounds max** per PR (round ≥4 = "human decides" banner + escalation suppressed; round >4 forces `rethink`)
- **Escalation to Tier 3 is a RECOMMENDATION** (Tier 2 verdict only — no label, no auto-trigger): the sticky recommends a deep review when verdict = `rethink`, OR `sensitive_paths_touched` AND blocking>0, OR total blocking > 5, OR PR diff > 500 lines. Claude Code dispatches Tier 3 manually if it agrees
- **A PR that modifies these workflow files can't be auto-reviewed** — `claude-code-action` 401s on workflow-content mismatch vs `main`, so specialists fail at startup until merge (the deterministic verdict job still runs + posts a degraded sticky). Judge on standard CI + impartial judge. See memory `feedback_review_workflow_validation_gate`
- **CI must be green** before merge unless `expected-ci-fail` label is set
- **Never manually add `claude[bot]` as a reviewer** — it auto-runs from the workflow
- **Don't use `--squash` or `--rebase` merge** — `--merge` only

## Canonical workflow

The autonomous review loop (poll → address → judge → merge → handoff) lives in `~/.claude/CLAUDE.md` "PR Review Workflow (canonical)". The judge step uses an impartial `general-purpose` sub-agent to decide `merge | re-review | human-decides`.
