#!/bin/bash
# Hook: PostToolUse (matcher: Write|Edit|MultiEdit)
# Auto-formats files after every Claude edit.
#
# SETUP:
# 1. Install your formatter (e.g., npm install -g prettier)
# 2. Update the FORMAT_CMD below for your project
# 3. Add this to .claude/settings.json or ~/.claude/settings.json:
#
# {
#   "hooks": {
#     "PostToolUse": [{
#       "matcher": "Write|Edit|MultiEdit",
#       "hooks": [{
#         "type": "command",
#         "command": ".claude/hooks/post-edit-format.sh"
#       }]
#     }]
#   }
# }

FILE_PATH="$CLAUDE_TOOL_INPUT_FILE_PATH"

# Skip if no file path (shouldn't happen, but safety first)
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Skip non-code files
case "$FILE_PATH" in
  *.md|*.txt|*.json|*.yml|*.yaml|*.lock|*.svg|*.png|*.jpg)
    exit 0
    ;;
esac

# CUSTOMIZE: Set your formatter command
# Examples:
#   Node/TS:  npx prettier --write "$FILE_PATH"
#   Python:   black "$FILE_PATH"
#   Go:       gofmt -w "$FILE_PATH"
#   Rust:     rustfmt "$FILE_PATH"
#   Swift:    swiftformat "$FILE_PATH"

# FORMAT_CMD="npx prettier --write"
# $FORMAT_CMD "$FILE_PATH" 2>/dev/null

# Uncomment the line above and set your formatter.
# Until configured, this hook is a no-op.
exit 0
