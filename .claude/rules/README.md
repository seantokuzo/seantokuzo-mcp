# Path-Scoped Rules

Rules in this directory are automatically loaded by Claude Code when it reads files matching the `paths` pattern in each rule's frontmatter.

## How It Works

1. Create a `.md` file in this directory
2. Add YAML frontmatter with `paths` — a glob array of file patterns
3. Write your rules in the body
4. When Claude reads a file matching any pattern, the rule loads into context

## Example

```yaml
---
paths: ["src/api/**/*.ts"]
---

# API Conventions

- All endpoints must validate input with zod schemas
- Return consistent error shapes: { error: string, code: number }
- Log all errors with structured logging (pino)
```

## Tips

- **Be specific** — Rules should apply to a clear subset of files
- **Keep it short** — Rules load into context, so every line costs tokens
- **No duplicates** — Don't repeat what's already in CLAUDE.md
- **Test coverage** — Rules only fire on file reads, not writes (known limitation)

## Common Patterns

| Rule File | Paths | Purpose |
|-----------|-------|---------|
| `frontend.md` | `["src/components/**", "src/pages/**"]` | Component conventions |
| `backend.md` | `["src/api/**", "src/services/**"]` | API and service patterns |
| `testing.md` | `["**/*.test.*", "**/*.spec.*"]` | Test writing conventions |
| `database.md` | `["src/models/**", "src/migrations/**"]` | Schema and migration rules |

See `example-frontend.md` and `example-backend.md` for starter templates.
