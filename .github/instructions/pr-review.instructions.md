---
applyTo: "**/*"
---

# PR Review — Addressing Claude Auto-Review

**Canonical workflow lives in `~/.claude/CLAUDE.md` "PR Review Workflow (canonical)".** This file is project-specific extension only.

## Tier configuration (this project)

See `CLAUDE.md` "Reviewing with @claude" for the full tier table. TL;DR:
- **Tier 1**: `@claude` mention → Opus 4.6 max effort, single Q&A response (`.github/workflows/claude.yml`)
- **Tier 2**: every non-draft PR → 3 parallel specialists (Security / Architecture / Correctness) at Opus 4.7 xhigh + verdict synthesizer (`.github/workflows/claude-code-review.yml`)
- **Tier 3**: label `claude-deep-review` (manual or auto-escalated) → Opus 4.7 max effort + 4 specialists (adds Threat Model) (`.github/workflows/claude-deep-review.yml`)

All tiers READ-ONLY (`Edit`, `Write`, `NotebookEdit` disallowed at the workflow level).

## Sentinels and stickies

Each specialist embeds a JSON sentinel in its top-level summary comment for the synthesizer to parse:

```html
<!-- KUZO-REVIEW-JSON-{SECURITY|ARCHITECTURE|CORRECTNESS|THREATMODEL}
{"verdict":"...","blocking_count":N,"advisory_count":N,"sensitive_paths_touched":bool,"top_issues":[...],"rationale":"..."}
-->
```

The verdict synthesizer posts/updates the round sticky:
- Tier 2: `<!-- KUZO-VERDICT-STICKY -->` + `<!-- VERDICT_ROUND: N -->`
- Tier 3: `<!-- KUZO-DEEP-VERDICT-STICKY -->` + `<!-- DEEP_VERDICT_ROUND: N -->`

The sticky is the round-completion signal. Its body is the canonical verdict for the round.

## Comment categorization (skepticism applies)

For every comment Claude posts, decide:

| Category | Action | When to use |
|----------|--------|-------------|
| **fix-now** | Fix in current PR | Real bugs, type errors, security issues, missing Zod, cross-plugin imports |
| **respond** | Reply explaining why no change | Intentional design, false positive, framework guarantee makes it impossible |
| **defer** | File a follow-up issue, link it in reply | Valid but out-of-scope for the PR's stated goal |

**You have MORE context than the reviewer.** Push back inline when:

1. The comment suggests defensive code for impossible cases (type system / framework guarantees)
2. It recommends architecture changes already locked in `docs/PLANNING.md`
3. It asks for tests when vitest isn't wired in CI yet
4. It conflicts with conventions documented in `CLAUDE.md`
5. It proposes premature abstraction (three similar lines is fine)

## Reply protocol

```bash
# Read PR comments — use per_page=100 to avoid silent truncation
gh api "repos/seantokuzo/seantokuzo-mcp/pulls/{number}/comments?per_page=100"

# Reply to each comment in its thread (never batch into one PR comment)
gh api repos/seantokuzo/seantokuzo-mcp/pulls/{number}/comments/{comment_id}/replies \
  -f body="Fixed in {sha} — {what changed}"
```

**Templates:**

```markdown
# Fixed
Fixed in {sha} — {what changed}.

# Intentional / framework guarantee
Intentional — `{type}` in `{path}` makes this case unreachable: the loader
narrows to `{X}` before {Y} is called. See `packages/core/src/loader/{file}:{line}`.

# Out of scope (deferred)
Valid concern. Tracked as #{issue} for a follow-up PR — out of scope for
this {scope-description} PR.

# Pushback (incorrect comment)
This recommendation conflicts with `CLAUDE.md` "Anti-Patterns": no
premature abstraction. Three similar lines is preferred to a wrapper that
locks future flexibility.
```

## When to trigger Tier 1 / Tier 3 manually

- **`@claude check why CI is failing`** — Tier 1, Opus 4.6 inspects logs via `mcp__github_ci__*` tools
- **`@claude review the install CLI for prompt-injection vectors`** — Tier 1, targeted security read
- **Label `claude-deep-review`** — when you suspect the auto-review missed something or the PR is large/sensitive
- **`gh workflow run claude-deep-review.yml -f pr_number=N`** — same, via CLI

## What NOT to do

- **Don't fix silently** — every comment gets an inline reply (fix or pushback)
- **Don't batch replies** in one top-level PR comment
- **Don't manually request the Claude bot** as a reviewer — it auto-runs from the workflow
- **Don't paste sentinel JSON** into your replies — the synthesizer regenerates them
- **Don't use `--squash` merge** unless project conventions say otherwise
