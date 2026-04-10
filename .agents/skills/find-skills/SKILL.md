---
name: find-skills
description: Discover and install agent skills from the community ecosystem. Use when looking for specialized capabilities, asking "how do I do X", or wanting to extend agent knowledge.
---

# Find Skills

Discover and install skills from the open agent skills ecosystem.

## When to Use

- User asks "how do I do X" where X might have an existing skill
- User says "find a skill for X" or "is there a skill for X"
- User wants to extend agent capabilities for a specific domain
- User mentions a specialized task (design systems, testing, deployment, etc.)

## The Skills CLI

`npx skills` is the package manager for agent skills.

**Key commands:**

```bash
npx skills find [query]     # Search for skills
npx skills add <package>    # Install a skill
npx skills check            # Check for updates
npx skills update           # Update all skills
```

**Browse skills at:** https://skills.sh/

## How to Help Users Find Skills

### Step 1: Understand the Need

Identify:
1. The domain (React, testing, DevOps, etc.)
2. The specific task (writing tests, deploying, reviewing code)
3. Whether a skill likely exists for this

### Step 2: Search

```bash
npx skills find [query]
```

Examples:
- "how do I optimize React?" → `npx skills find react performance`
- "help with PR reviews" → `npx skills find pr review`
- "need a changelog" → `npx skills find changelog`

### Step 3: Present Options

Show the user:
1. Skill name and what it does
2. Install command
3. Link to learn more

### Step 4: Install

```bash
npx skills add <owner/repo@skill> -g -y
```

`-g` = global (user-level), `-y` = skip confirmation.

## Common Categories

| Category | Example Queries |
|----------|----------------|
| Web Dev | react, nextjs, typescript, tailwind |
| Testing | testing, jest, playwright, e2e |
| DevOps | deploy, docker, kubernetes, ci-cd |
| Docs | docs, readme, changelog |
| Quality | review, lint, refactor, best-practices |
| Design | ui, ux, design-system, accessibility |

## When No Skills Found

1. Acknowledge no match
2. Offer to help directly
3. Suggest creating a custom skill: `npx skills init my-skill`
