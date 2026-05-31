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
| 2 | `claude-code-review.yml` | PR open/sync/ready, `workflow_dispatch` | Opus 4.7 | `xhigh` |
| 3 | `claude-deep-review.yml` | label `claude-deep-review`, `workflow_dispatch` | Opus 4.7 | `max`, 150 turns |

## Sentinels (HTML-commented JSON in specialist comments)

```html
<!-- KUZO-REVIEW-JSON-{SECURITY|ARCHITECTURE|CORRECTNESS|THREATMODEL}
{"verdict":"...","blocking_count":N,"advisory_count":N,"sensitive_paths_touched":bool,"top_issues":[...],"rationale":"..."}
-->
```

## Verdict (deterministic, not an LLM)

The verdict sticky is computed by **`.github/scripts/aggregate-verdict.mjs`** — a plain Node `run:` step (PR #60), NOT an LLM. It parses the specialist sentinels, computes verdict/counts/round/escalation as code, and posts via `gh api --input -` (body as JSON on stdin → no shell parses it). Unit-tested in `.github/scripts/aggregate-verdict.test.mjs`, gated on `ci-success`.

## Stickies

- Tier 2: `<!-- KUZO-VERDICT-STICKY -->` + `<!-- VERDICT_ROUND: N -->` + `<!-- VERDICT_HEAD_SHA: <sha> -->`
- Tier 3: `<!-- KUZO-DEEP-VERDICT-STICKY -->` + `<!-- DEEP_VERDICT_ROUND: N -->` + `<!-- VERDICT_HEAD_SHA: <sha> -->`

The sticky's `VERDICT_HEAD_SHA` matching the PR head is the round-completion signal.

## Hard rules

- **4 rounds max** per PR (round ≥4 = "human decides" banner + escalation suppressed; round >4 forces `rethink`)
- **Auto-escalation** to Tier 3 (Tier 2 only) fires when: verdict = `rethink`, OR `sensitive_paths_touched` AND blocking>0, OR total blocking > 5, OR PR diff > 500 lines. NB: a bot-applied `claude-deep-review` label does NOT auto-trigger Tier 3 (default-token recursion suppression) — dispatch it manually
- **A PR that modifies these workflow files can't be auto-reviewed** — `claude-code-action` 401s on workflow-content mismatch vs `main`, so specialists fail at startup until merge (the deterministic verdict job still runs + posts a degraded sticky). Judge on standard CI + impartial judge. See memory `feedback_review_workflow_validation_gate`
- **CI must be green** before merge unless `expected-ci-fail` label is set
- **Never manually add `claude[bot]` as a reviewer** — it auto-runs from the workflow
- **Don't use `--squash` or `--rebase` merge** — `--merge` only

## Canonical workflow

The autonomous review loop (poll → address → judge → merge → handoff) lives in `~/.claude/CLAUDE.md` "PR Review Workflow (canonical)". The judge step uses an impartial `general-purpose` sub-agent to decide `merge | re-review | human-decides`.
