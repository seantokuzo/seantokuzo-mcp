# 🐚 Kuzo MCP - Bash CLI

> A lightweight pure bash implementation of the Kuzo MCP CLI - works ANYWHERE!

## ✨ Features

Same functionality as the Node CLI, but runs anywhere with just bash and curl!

- **🔀 PR Creation** - Create pull requests interactively
- **✏️ PR Updates** - Update PR titles and descriptions
- **📋 PR Listing** - List and browse PRs
- **📦 Repo Management** - Create repos, list your repos
- **🎫 JIRA Integration** - View tickets, move status, add comments, search
- **🎨 Colors!** - Full ANSI color support for that premium terminal experience
- **🚫 Zero Dependencies** - No jq, no python, no node - just bash!

## 📋 Requirements

- **bash** 3.2+ (pre-installed on macOS and Linux)
- **curl** (pre-installed on virtually every system)
- **That's it!** No jq, no python, no node, no nothing else!

## 🚀 Quick Start

```bash
# Make sure you're in the project root (where .env is)
cd /path/to/seantokuzo-mcp

# Run the CLI
./cli-bash/kuzo

# Or add to PATH for global access
ln -s "$(pwd)/cli-bash/kuzo" /usr/local/bin/kuzo
```

## 📖 Usage

```bash
# Interactive mode (default)
./kuzo

# Direct commands
./kuzo pr create        # Create a pull request
./kuzo pr list          # List pull requests
./kuzo pr update        # Update a pull request

./kuzo repo create      # Create a repository
./kuzo repo list        # List your repositories

./kuzo jira mine        # View your tickets
./kuzo jira reviews     # View code review tickets
./kuzo jira move        # Move ticket status
./kuzo jira comment     # Add comment
./kuzo jira search      # Search tickets

./kuzo config status    # Check configuration
./kuzo setup            # Run setup wizard

./kuzo --help           # Show help
./kuzo --version        # Show version
```

## ⚙️ Configuration

The bash CLI reads from the same `.env` file as the Node CLI:

```bash
# GitHub (required)
GITHUB_TOKEN=ghp_xxxx
GITHUB_USERNAME=yourusername

# JIRA (optional)
JIRA_HOST=company.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=xxxxx
```

Or run `./kuzo setup` for interactive configuration.

## 🆚 Node CLI vs Bash CLI

| Feature             | Node CLI         | Bash CLI         |
| ------------------- | ---------------- | ---------------- |
| Dependencies        | Node.js, npm     | bash, curl only! |
| Install size        | ~100MB           | ~0 (built-in)    |
| Startup time        | ~500ms           | ~50ms            |
| Colors              | Rich gradients   | ANSI colors      |
| Interactive         | Inquirer prompts | Basic prompts    |
| Editor integration  | Full             | Basic            |
| MCP Server          | ✅               | ❌               |
| Webhook Server      | ✅               | ❌               |
| Locked-down servers | ❌               | ✅               |

**When to use Bash CLI:**

- Restrictive work servers where you can't install anything
- CI/CD environments
- Quick one-off operations
- SSH sessions on remote servers
- Minimalist setups

**When to use Node CLI:**

- Your main development machine
- When you need MCP/Claude integration
- Richer interactive experience
- Full feature set

## 🎨 Colors

The bash CLI supports full ANSI colors including:

- Status indicators (green ✓, red ✗, yellow ⚠)
- Gradient-style banner
- Syntax highlighting for commands
- Dim text for secondary information

Colors automatically disable if output is piped or terminal doesn't support them.

## 📝 Notes

- The bash CLI reads the `.env` file from the project root
- JSON parsing is done with pure bash (grep/sed) - no jq needed!
- For PR descriptions, use `edit` to open your `$EDITOR` (defaults to vi)

## 🔧 Troubleshooting

**"curl: command not found"**
This is extremely rare - curl is pre-installed on basically everything.

```bash
which curl
```

**Permission denied?**

```bash
chmod +x cli-bash/kuzo
```

**Colors not showing?**
Make sure your terminal supports ANSI colors. Try:

```bash
echo -e "\033[0;32mGreen\033[0m"
```
