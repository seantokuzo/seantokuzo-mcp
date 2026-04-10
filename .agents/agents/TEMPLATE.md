# Creating a New Agent Role

## When to Create a New Agent

Create a new specialist when:
- A domain requires specific expertise (e.g., mobile, DevOps, ML, game engine)
- Multiple tasks will target this domain across phases
- The domain has unique conventions that differ from frontend/backend

Don't create a new agent for:
- One-off tasks (just give the task to an existing specialist)
- Tasks that clearly fit an existing role

## Template

Copy this template and save as `.agents/agents/{role-name}.md`:

```markdown
# {{PROJECT_NAME}} — {Role Name} Agent

## Role & Purpose

You are the **{role description}** for {{PROJECT_NAME}}. You {what you do in one sentence}.

## Before Starting Any Task

1. **Read `CLAUDE.md`** — Project conventions
2. **Read `docs/PLANNING.md`** — Relevant sections for your task
3. **Read this file** — Your role-specific guidance
4. **Check Context7** — For ALL framework/library APIs you'll use
5. **Read relevant skills** — `.agents/skills/` for domain-specific knowledge

## Core Principles

- **Context7 first** — Never trust training data for library APIs
- **Match existing patterns** — Read before writing
- {Add 3-5 domain-specific principles}

## Implementation Checklist

Before marking any task complete:

- [ ] Code compiles with no type errors
- [ ] Follows project conventions (CLAUDE.md)
- [ ] {Add domain-specific quality checks}

## Common Anti-Patterns (Avoid)

- {List domain-specific mistakes to avoid}

## File Organization

{Describe the directory structure this agent works in}

## Workflow

1. **Read the task** — Understand what and why
2. **Read existing code** — Check patterns
3. **Check Context7** — Verify APIs
4. **Implement** — Write code, follow conventions
5. **Self-review** — Read your own diff
6. **Verify** — Build passes, tests pass
7. **Commit** — One atomic commit
```

## Registering the Agent

After creating the file, update these places:

1. **`CLAUDE.md`** — Add to the Agent Roles table
2. **`orchestrator.md`** — Add to the "Spawn Workers" routing table
3. **`.github/instructions/workflow.instructions.md`** — Add to the Implementer Selection table

## Tips

- Keep the file under 150 lines — agents should be focused
- Include specific anti-patterns from the domain
- Reference Context7 libraries the agent will commonly use
- Include a file organization section showing the directory structure
