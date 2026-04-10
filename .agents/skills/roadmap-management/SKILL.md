---
name: roadmap-management
description: Plan and manage phase-based roadmaps. Use when planning new phases, reprioritizing work, managing dependencies between waves, or deciding what to build next.
---

# Roadmap Management Skill

Phase-based roadmap planning for the GSD workflow. No sprints, no story points, no Jira. Just phases that deliver observable user capabilities.

## Core Concept: Phases

A **phase** is a unit of work that delivers something the user can see, touch, or use. Each phase has:

- A **name/theme** (e.g., "Hello World", "Auth & Security", "Real-Time Dashboard")
- **Clear success criteria** — What can the user do after this phase ships?
- **Waves** — Dependency-grouped tasks that execute in parallel

### Phase Structure

```markdown
## Phase N: "Theme Name"

### Success Criteria
- [ ] User can do X
- [ ] User can do Y
- [ ] System handles Z

### Wave 1 (Independent)
- Task A (frontend) — description
- Task B (backend) — description

### Wave 2 (Depends on Wave 1)
- Task C (frontend) — needs Wave 1 API
- Task D (integration) — needs both A and B

### Deferred
- Item X — noted for Phase N+1
```

## Planning a New Phase

### 1. Identify the Goal

Ask: **"What can the user do after this phase that they can't do now?"**

The answer should be concrete and observable:
- "User can log in and see their dashboard" (good)
- "Improve the architecture" (bad — not user-observable)

### 2. Decompose into Tasks

Break the goal into atomic tasks. Each task should:
- Touch ONE component/domain
- Be completable in one agent session
- Result in one atomic commit
- Have clear success criteria

### 3. Map Dependencies

```
Task A ──┐
         ├──► Task D (needs A + B)
Task B ──┘
Task C ────► Task E (needs C)
```

### 4. Group into Waves

- **Wave 1**: Tasks with no dependencies (run in parallel)
- **Wave 2**: Tasks that depend on Wave 1 outputs (run in parallel within wave)
- **Wave N**: Continue until all tasks are scheduled

### 5. Estimate Complexity

Not time — complexity:

| Size | Description | Agent Sessions |
|------|-------------|---------------|
| **S** | Single file, clear pattern | 1 session |
| **M** | Multiple files, some decisions | 1-2 sessions |
| **L** | Cross-cutting, architecture decisions | 2-3 sessions |
| **XL** | Should probably be split into smaller tasks | Split it |

## Prioritization

### Now / Next / Later

The simplest framework. Use this by default:

- **Now** (current phase): Committed. Building this.
- **Next** (next phase): Planned. Scoped but not started.
- **Later** (backlog): Directional. Will refine when closer.

### When Scope Creeps

During implementation, new work will be discovered. For each item:

1. **Is it blocking?** → Add to current phase
2. **Is it important but not blocking?** → Create GitHub Issue, tag for next phase
3. **Is it nice-to-have?** → Create GitHub Issue, tag as backlog

Never expand the current phase's scope unless it's genuinely blocking.

## Tracking Progress

### In PLANNING.md

Update the roadmap section as phases complete:

```markdown
## Completed — Phase 1: "Hello World"
- [x] Task A — PR #1
- [x] Task B — PR #2
- [x] Task C — PR #3

## Current — Phase 2: "Auth & Security"
- [x] Wave 1 complete
- [ ] Wave 2 in progress
```

### In STATE.md

Update session state after milestones:

```markdown
## Current Phase
Phase 2: "Auth & Security" — Wave 2 in progress

## Recent Decisions
- Chose JWT over session cookies (see PLANNING.md)
- Deferred OAuth to Phase 3
```

### Deferred Work → GitHub Issues

All deferred items become GitHub Issues with labels:
- `phase-N` — Which phase it's targeted for
- `deferred` — Came from scope management
- `tech-debt` — Technical debt items
- `enhancement` — Nice-to-have improvements

## Phase Completion Checklist

Before declaring a phase complete:

- [ ] All success criteria met
- [ ] All PRs merged to main
- [ ] PLANNING.md updated with completion status
- [ ] STATE.md updated with current phase
- [ ] Deferred items tracked as GitHub Issues
- [ ] No known regressions introduced
