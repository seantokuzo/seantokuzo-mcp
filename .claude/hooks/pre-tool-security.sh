#!/bin/bash
# Hook: PreToolUse (matcher: Read|Write|Edit|Bash)
# Blocks access to sensitive files and dangerous commands.
#
# Exit codes:
#   0 = allow the operation
#   2 = BLOCK the operation (Claude will see the block message)
#
# SETUP: Add to .claude/settings.json or ~/.claude/settings.json:
#
# {
#   "hooks": {
#     "PreToolUse": [{
#       "matcher": "Read|Write|Edit|Bash",
#       "hooks": [{
#         "type": "command",
#         "command": ".claude/hooks/pre-tool-security.sh"
#       }]
#     }]
#   }
# }

# Require jq — if not installed, block by default (fail secure)
if ! command -v jq &>/dev/null; then
  echo "Security hook requires jq. Install with: brew install jq (macOS) or apt install jq (Linux)" >&2
  exit 2
fi

# Read the tool input from stdin
INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.command // empty')

# --- File Access Blocks ---
if [ "$TOOL_NAME" = "Read" ] || [ "$TOOL_NAME" = "Write" ] || [ "$TOOL_NAME" = "Edit" ]; then
  case "$FILE_PATH" in
    *.env|*.env.*|.env)
      echo '{"decision": "block", "reason": "Blocked: .env files contain secrets. Use environment variables instead."}' | jq .
      exit 2
      ;;
    *credentials*|*secrets*|*.pem|*.key)
      echo '{"decision": "block", "reason": "Blocked: This file likely contains sensitive credentials."}' | jq .
      exit 2
      ;;
  esac
fi

# --- Dangerous Command Blocks ---
if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

  # Block destructive git operations
  case "$COMMAND" in
    *"git push --force"*|*"git push -f"*)
      echo '{"decision": "block", "reason": "Blocked: Force push is destructive. Use --force-with-lease if absolutely necessary."}' | jq .
      exit 2
      ;;
    *"git reset --hard"*)
      echo '{"decision": "block", "reason": "Blocked: Hard reset discards work. Stash changes first if needed."}' | jq .
      exit 2
      ;;
    *"rm -rf /"*|*"rm -rf ~"*)
      echo '{"decision": "block", "reason": "Blocked: Recursive delete on root/home/cwd is too dangerous."}' | jq .
      exit 2
      ;;
  esac
fi

# Allow everything else
exit 0
