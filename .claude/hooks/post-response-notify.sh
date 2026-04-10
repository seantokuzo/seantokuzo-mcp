#!/bin/bash
# Hook: PostResponse (matcher: "")
# Sends a macOS notification when Claude finishes a response.
# Great for long-running tasks so you don't have to watch the terminal.
#
# SETUP: Add to .claude/settings.json or ~/.claude/settings.json:
#
# {
#   "hooks": {
#     "PostResponse": [{
#       "matcher": "",
#       "hooks": [{
#         "type": "command",
#         "command": ".claude/hooks/post-response-notify.sh"
#       }]
#     }]
#   }
# }
#
# =============================================================================
# OPTION 1: macOS Desktop Only (active by default)
# =============================================================================
if [[ "$OSTYPE" == "darwin"* ]]; then
  osascript -e 'display notification "Claude finished working" with title "Claude Code" sound name "Glass"' 2>/dev/null
fi

# =============================================================================
# OPTION 2: Pushover — iPhone + Apple Watch push notifications ($4.99 one-time)
# The best option for getting a tap on your wrist when Claude finishes.
# Setup: https://pushover.net — create account, register app, get tokens.
# =============================================================================
# PUSHOVER_TOKEN="your_app_token"
# PUSHOVER_USER="your_user_key"
# curl -s \
#   --form-string "token=$PUSHOVER_TOKEN" \
#   --form-string "user=$PUSHOVER_USER" \
#   --form-string "message=Claude finished working" \
#   --form-string "title=Claude Code" \
#   --form-string "sound=pushover" \
#   https://api.pushover.net/1/messages.json >/dev/null 2>&1

# =============================================================================
# OPTION 3: ntfy.sh — Free, open-source push notifications (no Apple Watch)
# Setup: Install ntfy app on iOS, subscribe to your topic. That's it.
# =============================================================================
# NTFY_TOPIC="your-secret-topic-name"
# curl -s \
#   -H "Title: Claude Code" \
#   -H "Priority: high" \
#   -d "Claude finished working" \
#   "ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1

# =============================================================================
# OPTION 4: Linux — uncomment if using notify-send
# =============================================================================
# if command -v notify-send &>/dev/null; then
#   notify-send "Claude Code" "Claude finished working"
# fi

exit 0
