---
applyTo: "**/*"
---

# GitHub Integration

## Repository Details

| Property | Value |
|----------|-------|
| **Owner** | `seantokuzo` |
| **Repo** | `seantokuzo-mcp` |
| **URL** | https://github.com/seantokuzo/seantokuzo-mcp |
| **PRs** | https://github.com/seantokuzo/seantokuzo-mcp/pulls |
| **Default Branch** | `main` |
| **Username** | `seantokuzo` |

## Branch Strategy

| Scope | Branch Pattern | Example |
|-------|---------------|---------|
| **Phase work** | `phase-N/feature-name` | `phase-1/auth-scaffold` |
| **Bug fix** | `fix/description` | `fix/login-redirect` |
| **Docs** | `docs/description` | `docs/api-spec` |

### Commit Convention

```
type(scope): description
```

**Types**: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`
**Scopes**: `core`, `plugins`, `github`, `jira`, `git`, `cli`, `config`

Examples:

```bash
git commit -m "feat(backend): add auth middleware"
git commit -m "fix(frontend): handle empty state in dashboard"
git commit -m "test(backend): add integration tests for auth flow"
```

### PR Naming

```
Phase N: description
```

For bug fixes or non-phase work:

```
fix: description of the fix
```

## PR Setup (ALL MANDATORY)

When creating a PR:

1. **Create PR** (not draft)
2. **Assign `@seantokuzo`**
3. **Apply labels**: component + type + `Needs Review`
4. **Copilot auto-reviews** (ensure auto-review is enabled in repo settings)
5. **Run PR review pipeline** (`.agents/skills/pr-review-pipeline/SKILL.md`)

## PR Labels

### Component Labels (based on files changed)

| Label | When to Apply |
|-------|-------------|
| **Core** | Changes to `src/core/` |
| **Plugins** | Changes to `src/plugins/` |
| **CLI** | Changes to `src/cli/` |
| **Docs** | Documentation changes |

### Type Labels

| Label | When to Apply |
|-------|-------------|
| **Bug Fix** | Fixing a bug |
| **Breaking Change** | Breaking API or protocol changes |

### Status Labels

| Label | When to Apply |
|-------|-------------|
| **Needs Review** | PR ready for review (agent applies) |
| **Accepted** | Human approved, ready to merge |

### CI Labels (auto-applied by GitHub Actions)

| Label | Trigger |
|-------|---------|
| **Lint Failure** | Lint job fails |
| **Type Error** | Typecheck job fails |
| **Test Failure** | Test job fails |
| **Build Failure** | Build job fails |
| **CI Pass** | All jobs pass |

## PR Template

**ALWAYS** use the PR template at `.github/PULL_REQUEST_TEMPLATE.md`. Fill in ALL sections.

## MCP Tools for GitHub

### Creating PRs

```
mcp__github__create_pull_request
- owner: "seantokuzo"
- repo: "seantokuzo-mcp"
- title: "Phase 1: Feature description"
- body: "## Summary\n..."
- head: "phase-1/feature-name"
- base: "main"
```

### Reading PR Comments

```bash
# Get all review comments
gh api repos/seantokuzo/seantokuzo-mcp/pulls/{number}/comments

# Reply to a specific comment
gh api repos/seantokuzo/seantokuzo-mcp/pulls/{number}/comments/{comment_id}/replies \
  -f body="Fixed in abc123"
```
