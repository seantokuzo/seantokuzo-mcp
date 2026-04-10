---
name: pr-review-pipeline
description: Automated Copilot review pipeline with dynamic comment thresholds. Polls for Copilot review, addresses comments, replies inline, and loops until clean enough to merge. Run after every PR creation.
---

# PR Review Pipeline

Automated multi-round code review workflow using **GitHub Copilot** as the sole automated reviewer (runs on your Copilot subscription). After creating a PR, run this pipeline to ensure all review comments are addressed before merge.

## When to Use

**ALWAYS** after creating a PR via `gh pr create`. This is a mandatory step in the workflow.

## Reviewer

| Reviewer | How It Triggers | What It's Good At |
|----------|----------------|-------------------|
| **GitHub Copilot** | Auto-requested via repo settings, or manually re-requested | General code quality, patterns, bugs, security |

### Setup: Enable Copilot Auto-Review

In your GitHub repo: **Settings > Copilot > Code Review > Enable automatic review requests**

This makes Copilot auto-review every new PR and every push to an open PR.

## Pipeline Steps

### Step 1: Wait for Copilot Review

Copilot auto-reviews when the PR is created (if configured). Poll the `requested_reviewers` endpoint — Copilot appears there while reviewing and drops off once it submits.

```bash
# Poll every 30s for up to 5 minutes
for i in {1..10}; do
  PENDING=$(gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR_NUMBER}/requested_reviewers \
    --jq '[.users[] | select(.login | test("copilot"; "i"))] | length')
  if [ "$PENDING" -eq 0 ]; then
    # Verify Copilot actually submitted a review (not just never assigned)
    REVIEWED=$(gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR_NUMBER}/reviews \
      --jq '[.[] | select(.user.login | test("copilot"; "i"))] | length')
    if [ "$REVIEWED" -gt 0 ]; then
      echo "Copilot review complete"
      break
    fi
    echo "Waiting for Copilot to be assigned... (attempt $i/10)"
  else
    echo "Copilot is reviewing... (attempt $i/10)"
  fi
  sleep 30
done
```

> **How it works:** The `requested_reviewers` API returns users that have been asked to review but haven't submitted yet. Once Copilot finishes and submits its review, it drops off that list. This is more reliable than polling for review/comment counts or comparing timestamps.
>
> **Note:** Copilot's username may vary (`copilot-pull-request-reviewer[bot]`, `github-copilot[bot]`, etc.). The `test("copilot"; "i")` filter covers known variants. If polling times out, check the PR manually and adjust the filter if needed.

### Step 2: Read All Comments

**Round 1** — read all top-level comments:

```bash
gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR_NUMBER}/comments \
  --jq '.[] | select(.in_reply_to_id == null) | {id, user: .user.login, path, line: (.line // .original_line), body: (.body | split("\n")[0])}'
```

**Subsequent rounds** — only read NEW comments (use `COMMENTS_BEFORE` from Step 8 as the baseline):

```bash
# Fetch all top-level comments, grab only the last N (where N = NEW_COMMENTS from Step 10)
NEW_COMMENTS=... # from Step 10
gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR_NUMBER}/comments \
  --jq --argjson n "$NEW_COMMENTS" \
  '[.[] | select(.in_reply_to_id == null)] | sort_by(.created_at) | .[-$n:] | .[] | {id, user: .user.login, path, line: (.line // .original_line), body: (.body | split("\n")[0])}'
```

Focus on **top-level comments only**. In subsequent rounds, ignore already-addressed comments — only process the newest ones since your last push.

### Step 3: Calculate Smart Threshold

Determine the comment threshold based on PR size:

```bash
# Get PR stats
STATS=$(gh pr view {PR_NUMBER} --json additions,deletions,changedFiles)
ADDITIONS=$(echo "$STATS" | jq '.additions')
DELETIONS=$(echo "$STATS" | jq '.deletions')
CHANGED_FILES=$(echo "$STATS" | jq '.changedFiles')
TOTAL_LINES=$((ADDITIONS + DELETIONS))

# Smart threshold calculation
if [ "$TOTAL_LINES" -lt 100 ] && [ "$CHANGED_FILES" -lt 5 ]; then
  THRESHOLD=3    # Small PR
  SIZE="small"
elif [ "$TOTAL_LINES" -lt 500 ] && [ "$CHANGED_FILES" -lt 15 ]; then
  THRESHOLD=5    # Medium PR
  SIZE="medium"
else
  THRESHOLD=8    # Large PR
  SIZE="large"
fi

echo "PR size: $SIZE ($TOTAL_LINES lines, $CHANGED_FILES files) — threshold: $THRESHOLD comments"
```

### Step 4: Categorize & Fix Every Comment

For each comment, categorize and act:

| Category | Action | When to Use |
|----------|--------|-------------|
| **fix-now** | Fix in current PR | Real bugs, type errors, security issues |
| **respond** | Reply explaining why no change | Intentional design, false positives, not applicable |
| **defer** | Acknowledge, note for later | Valid but out of scope for this PR |

**Critical: Be skeptical.** You have MORE context than Copilot. Before accepting a suggestion:

1. Does this apply to our setup?
2. Is this already handled elsewhere?
3. Is this a real problem or theoretical?
4. Does the fix add complexity for marginal benefit?
5. Would a human reviewer with full project context make this same comment?

### Step 5: Build Verify

After all fixes, verify nothing is broken:

```bash
# Run the full CI pipeline locally (adapt to your stack)
# See .github/instructions/ci.instructions.md for project-specific commands
```

### Step 6: Commit and Push

```bash
git add -A && git commit -m "$(cat <<'EOF'
fix(scope): address round N Copilot review comments

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
git push origin {BRANCH}
```

### Step 7: Reply Inline to Every Comment

Reply to EACH comment in its own thread (never as unlinked PR comments):

```bash
# Fixed
gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR_NUMBER}/comments/{COMMENT_ID}/replies \
  -f body="Fixed — {brief description of what was done}"

# Not applicable
gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR_NUMBER}/comments/{COMMENT_ID}/replies \
  -f body="Not applicable — {specific reason why this doesn't apply}"

# Deferred
gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR_NUMBER}/comments/{COMMENT_ID}/replies \
  -f body="Deferred — tracked as GitHub Issue for future work"
```

### Step 8: Snapshot & Re-Request Copilot Review

After pushing fixes and replying to all comments, **snapshot baselines** then re-request.

```bash
# Snapshot BEFORE re-requesting — used by Steps 9 and 10
REVIEWS_BEFORE=$(gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR_NUMBER}/reviews \
  --jq '[.[] | select(.user.login | test("copilot"; "i"))] | length')
COMMENTS_BEFORE=$(gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR_NUMBER}/comments \
  --jq '[.[] | select(.in_reply_to_id == null)] | length')
```

**Then re-request Copilot review via API:**

```bash
gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR_NUMBER}/requested_reviewers \
  -X POST -f 'reviewers[]=copilot-pull-request-reviewer'
```

> **If the API call fails** (404, 422, or Copilot's reviewer username differs), tell the user:
> _"Can't re-request Copilot review via API. Please re-request manually in the GitHub UI, then let me know when you've done it."_
>
> Wait for the user to confirm before proceeding to Step 9.

### Step 9: Poll for New Copilot Review

After re-request (whether via API or user-triggered), poll `requested_reviewers` until Copilot finishes, then verify a new review was actually submitted:

```bash
# Wait for Copilot to drop off requested_reviewers
for i in {1..10}; do
  PENDING=$(gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR_NUMBER}/requested_reviewers \
    --jq '[.users[] | select(.login | test("copilot"; "i"))] | length')
  if [ "$PENDING" -eq 0 ]; then
    # Verify Copilot actually submitted a NEW review (not just failed to get assigned)
    REVIEWS_AFTER=$(gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR_NUMBER}/reviews \
      --jq '[.[] | select(.user.login | test("copilot"; "i"))] | length')
    if [ "$REVIEWS_AFTER" -gt "$REVIEWS_BEFORE" ]; then
      echo "New Copilot review received"
      break
    fi
    echo "Copilot not pending but no new review yet... (attempt $i/10)"
  else
    echo "Copilot still reviewing... (attempt $i/10)"
  fi
  sleep 30
done
```

### Step 10: Threshold Check & Loop

Count **all new top-level comments** from this round (Copilot + humans — all comments need addressing):

```bash
# Compare against baseline captured in Step 8
COMMENTS_AFTER=$(gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR_NUMBER}/comments \
  --jq '[.[] | select(.in_reply_to_id == null)] | length')
NEW_COMMENTS=$((COMMENTS_AFTER - COMMENTS_BEFORE))

if [ "$NEW_COMMENTS" -eq 0 ]; then
  echo "CLEAN ROUND — eligible for merge"
elif [ "$NEW_COMMENTS" -le "$THRESHOLD" ]; then
  echo "Under threshold ($NEW_COMMENTS <= $THRESHOLD) — address and proceed to merge"
else
  echo "Over threshold ($NEW_COMMENTS > $THRESHOLD) — another review round needed"
  # Go back to Step 2: read new comments, fix, push, re-request
fi
```

**Loop logic — no minimum rounds:**
- **0 new comments** → Clean round → merge
- **Under threshold** → Address comments, push fixes, merge
- **Over threshold** → Address comments, push fixes, re-request review, loop back to Step 9

### Step 11: Merge

After merge eligibility is met (clean round or under threshold with all comments addressed):

```bash
gh pr merge {PR_NUMBER} --merge --delete-branch
git checkout main && git pull origin main
```

Report the result:

```
PR #{NUMBER} merged after {N} review rounds:
- Round 1: {X} Copilot comments
- Round 2: {Y} comments addressed, {Z} new
- Round N: Clean pass → merged
- PR size: {SIZE} ({LINES} lines, {FILES} files), threshold: {THRESHOLD}
```

### Step 12: Prep Next Session Prompt

After merge, prepare a handoff summary so the next Claude session can pick up seamlessly:

```markdown
## Session Handoff — {BRANCH_NAME}

**What was done:**
- {Summary of changes merged in this PR}

**Current state:**
- On `main`, up to date with remote
- Phase {N} progress: {status}

**What's next:**
- {Next task/phase from PLANNING.md roadmap}

**Key decisions made:**
- {Any architectural or design decisions locked during this session}

**Files to read first:**
- docs/PLANNING.md (check roadmap progress)
- CLAUDE.md (project conventions)
- {Any other relevant files}
```

Present this to the user so they can paste it into the next session.

## Reply Format

When replying to comments, be specific:

- "Fixed — added null guard before property access"
- "Fixed — using constant instead of magic number"
- "Not applicable — this endpoint is internal-only, auth is handled by middleware upstream"
- "Deferred — tracked in Issue #XX for Phase N"
- "Intentional — see PLANNING.md section X for design rationale"

## GitHub API Reference

```bash
# List PR inline comments (review comments on diff)
gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR}/comments

# Reply to a specific comment (in its thread)
gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR}/comments/{ID}/replies -f body="..."

# List PR reviews (approve/request changes)
gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR}/reviews

# Check PR status
gh pr view {PR} --json mergeable,mergeStateStatus,statusCheckRollup

# Get PR size stats
gh pr view {PR} --json additions,deletions,changedFiles

# Check who's still pending review (Copilot drops off when done)
gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR}/requested_reviewers

# Re-request Copilot review (may need username adjustment)
gh api repos/seantokuzo/seantokuzo-mcp/pulls/{PR}/requested_reviewers \
  -X POST -f 'reviewers[]=copilot-pull-request-reviewer'
```
