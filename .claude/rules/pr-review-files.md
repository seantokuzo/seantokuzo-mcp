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
| 3 | `claude-deep-review.yml` | label `claude-deep-review`, `workflow_dispatch` | Opus 4.7 | `max`, 30 turns |

## Sentinels (HTML-commented JSON in specialist comments)

```html
<!-- KUZO-REVIEW-JSON-{SECURITY|ARCHITECTURE|CORRECTNESS|THREATMODEL}
{"verdict":"...","blocking_count":N,"advisory_count":N,"sensitive_paths_touched":bool,"top_issues":[...],"rationale":"..."}
-->
```

## Stickies

- Tier 2: `<!-- KUZO-VERDICT-STICKY -->` + `<!-- VERDICT_ROUND: N -->`
- Tier 3: `<!-- KUZO-DEEP-VERDICT-STICKY -->` + `<!-- DEEP_VERDICT_ROUND: N -->`

The sticky's update for the current head SHA is the round-completion signal.

## Hard rules

- **4 rounds max** per PR (synthesizer auto-escalates to `human-decides` after)
- **Auto-escalation** to Tier 3 fires when: any specialist verdict = `rethink`, OR `sensitive_paths_touched: true` AND blocking>0, OR total blocking > 5, OR PR diff > 500 lines
- **CI must be green** before merge unless `expected-ci-fail` label is set
- **Never manually add `claude[bot]` as a reviewer** — it auto-runs from the workflow
- **Don't use `--squash` or `--rebase` merge** — `--merge` only

## Canonical workflow

The autonomous review loop (poll → address → judge → merge → handoff) lives in `~/.claude/CLAUDE.md` "PR Review Workflow (canonical)". The judge step uses an impartial `general-purpose` sub-agent to decide `merge | re-review | human-decides`.
