---
applyTo: "**/*"
---

# CI / Pre-Push Quality Gates

**MANDATORY**: Before EVERY `git commit` or `git push`, run the full CI pipeline locally and confirm all steps pass. No exceptions.

## The CI Pipeline

The CI pipeline mirrors `.github/workflows/ci.yml`.

### Commands

```bash
npm run lint && npm run typecheck && npm run build
```

When tests are set up:

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

## Rules

1. **Run ALL steps** before every commit and push — not just the component you changed.
2. **Fix failures immediately** — do NOT commit or push code that fails any step.
3. **Re-run after fixes** — a lint fix can break typecheck or tests. Always re-run from the top.
4. **Never skip steps** — even if you think nothing changed.
5. **Check output** — read the output. Non-zero exit = failed.

## Common Pitfalls

### TypeScript

- **`async` without `await`**: If a handler doesn't use `await`, don't mark it `async`.
- **`||` vs `??`**: Use `??` for nullish coalescing.
- **`any` types**: Never. Use `unknown` and narrow.
- **Type-only imports**: Use `import type { Foo }` when only used as a type.
- **ESM imports**: Always use `.js` extensions in import paths, even for `.ts` files.

### General

- **Unused imports**: Remove them.
- **Console.log / print**: Remove debug statements before committing.
- **Hardcoded secrets**: Never. Use environment variables.

## Workflow

```
1. Make code changes
2. Run CI: npm run lint && npm run typecheck && npm run build
3. ALL pass? -> git add, commit, push
4. ANY fail? -> fix, go back to step 2
```

**NEVER push code that hasn't passed CI locally.**
