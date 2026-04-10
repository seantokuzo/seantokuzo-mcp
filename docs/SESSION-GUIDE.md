# Session Guide — Human Operator Playbook

> How to work with Claude as your engineering team. This is YOUR guide — the human in the loop.

---

## Your Role

You are the **architect and planning partner**. Claude is the engineering team. Your job:

1. **Set direction** — What phase are we in? What's the goal?
2. **Make decisions** — When Claude presents options, pick one
3. **Manage sessions** — Start fresh when context gets heavy
4. **Review output** — Approve PRs, verify the work makes sense
5. **Course correct** — If Claude goes off track, redirect

You do NOT need to:
- Write code (unless you want to)
- Debug build errors (Claude handles that)
- Manually run CI (Claude does it)
- Write PR descriptions (Claude does it)
- Address review comments (Claude does it)

---

## Session Lifecycle

### Starting a New Session

Every new Claude Code session starts fresh — no memory of previous conversations. To get Claude up to speed:

**Kickoff prompt (first session on a project):**

```
Read CLAUDE.md and docs/PLANNING.md. Let's plan Phase 1.
```

**Kickoff prompt (continuing work):**

```
Read CLAUDE.md, docs/PLANNING.md, and docs/STATE.md. We're in Phase N.
Continue where we left off — [brief context of what's next].
```

**Kickoff prompt (executing a planned phase):**

```
Read .agents/agents/orchestrator.md, CLAUDE.md, and docs/PLANNING.md.
Execute Phase N. Decompose into waves and start building.
```

### During a Session

Your main interactions:

| Situation | What to do |
|-----------|-----------|
| Claude presents options | Pick one. "Option B, let's go." |
| Claude asks a question | Answer it. Be decisive. |
| PR is ready for review | Check the diff, approve or request changes |
| Claude reports progress | Acknowledge. "Nice, keep going." |
| Something looks wrong | "Stop. That's not right because X. Do Y instead." |
| Phase completes | "Update PLANNING.md and STATE.md. What's next?" |

### When to Start a Fresh Session

**Context exhaustion signals:**

- Claude forgets recent decisions or repeats itself
- Response quality drops (vague, generic, or wrong)
- Claude searches for things it already found
- The session has been going for 2+ hours with heavy file work

**What to do:**

1. Make sure current work is committed/pushed
2. Note where you left off
3. Start a new session with the kickoff prompt above
4. Include any context Claude needs: "We just finished Wave 1 of Phase 3. Wave 2 needs X."

**Pro tip:** Claude will often tell you when context is heavy: _"Context is getting heavy — suggest fresh session."_ Trust this signal.

---

## The Planning Partner Workflow

### Phase Planning

When starting a new phase:

1. **Discuss the goal** — "What should the user be able to do after this phase?"
2. **Let Claude research** — "Research the APIs/libraries we'll need for this"
3. **Review the plan** — Claude will present tasks, waves, and estimates
4. **Approve or adjust** — "That looks good" or "Move task X to Wave 1"
5. **Execute** — "Build it"

### Mid-Phase Decisions

During execution, Claude will surface decisions:

```
I need to choose between:
A) Library X — faster but less flexible
B) Library Y — more setup but better long-term
C) Custom solution — full control but more code

Recommendation: Option B

What do you think?
```

Your job: Pick one. Don't agonize. You can always change it later.

### Scope Management

New work will be discovered during implementation. Claude should:

- **Add to current phase** if it's blocking
- **Create a GitHub Issue** if it's important but not blocking
- **Note it and move on** if it's nice-to-have

If Claude tries to expand scope, redirect: _"That's out of scope for this phase. Create an issue and move on."_

---

## PR Review Flow

When Claude creates a PR:

1. **Claude creates the PR** with full description, labels, and testing instructions
2. **Copilot auto-reviews** (configured in GitHub settings)
3. **Claude addresses all comments** — fixes, replies inline, pushes
4. **Smart threshold check** — if under threshold, merge. If over, fix and re-request another round
5. **Claude re-requests Copilot review** if needed (Copilot also auto-re-reviews on each push if enabled)
6. **Claude merges** and pulls to main

Your involvement: **Minimal.** Copilot auto-reviews on PR creation and on each push. You may occasionally need to manually re-request if the API call fails, but that's a rare fallback. You should review:
- Architecture decisions (is this the right approach?)
- Anything that touches security or auth
- Changes that feel too large (should they be split?)

---

## Useful Commands

### In Claude Code

| Command | What it does |
|---------|-------------|
| `/clear` | Clear the conversation (fresh context) |
| `/help` | Show Claude Code help |
| `! command` | Run a shell command in the session |

### Common Prompts

**Start executing:**
```
Read .agents/agents/orchestrator.md. Execute Phase N.
```

**Research something:**
```
Read .agents/agents/researcher.md. Research [topic] and give me
a prescriptive recommendation with confidence levels.
```

**Address PR comments:**
```
Read .agents/skills/pr-review-pipeline/SKILL.md.
Run the review pipeline on PR #XX.
```

**Check status:**
```
What's our current progress? Update docs/STATE.md.
```

**Create a GitHub Issue:**
```
Create a GitHub Issue for [description]. Label it as [phase-N/deferred/tech-debt].
```

---

## Troubleshooting

### Claude seems confused or off-track

**Redirect firmly:** "Stop. Re-read CLAUDE.md and docs/PLANNING.md. We're working on X, not Y."

### Claude keeps making the same mistake

**Add a rule:** "Add this to CLAUDE.md so you don't make this mistake again: [rule]"

Or tell Claude: _"Remember this for next time: [feedback]"_ — Claude will save it to memory.

### CI keeps failing

**Ask Claude to fix it:** "CI is failing on lint. Run the full CI pipeline locally, fix all issues, and push."

### Context is getting heavy mid-task

If Claude signals context exhaustion but you're mid-task:
1. Ask Claude to commit whatever is done
2. Get a summary of remaining work
3. Start fresh session with that summary

### Claude is being too cautious / asking too many questions

**Redirect:** "Just do it. I trust your judgment here. Ask me only if you hit a genuine blocker."

---

## Tips for Maximum Productivity

1. **Be decisive** — Every minute you deliberate, Claude is idle
2. **Trust the process** — The review pipeline catches mistakes
3. **Start fresh often** — A clean context session produces better output than a stale one
4. **Use memory** — Tell Claude to remember things that matter across sessions
5. **Update the plan** — Keep PLANNING.md and STATE.md current
6. **Create issues liberally** — Everything deferred becomes a GitHub Issue so nothing is lost
7. **Let Claude own the workflow** — You steer, Claude drives
