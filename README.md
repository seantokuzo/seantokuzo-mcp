# 🚀 Kuzo MCP

> PR Automation & GitHub Integration Tool with personality!

A Model Context Protocol (MCP) server and CLI tool for automating GitHub pull request management. Built with TypeScript, Node.js, and pure vibes.

## ✨ Features

- **🔀 PR Creation** - Create pull requests with auto-generated descriptions
- **✏️ PR Updates** - Update PR descriptions (auto-updates on push!)
- **📋 PR Listing** - List and browse PRs for any repo
- **🎫 JIRA Integration** - View tickets, manage workflow, link to PRs
- **🧠 MCP Server** - Let Claude manage your PRs for you
- **🌐 Webhook Server** - Auto-update PRs when you push
- **🎨 Sleek CLI** - Beautiful terminal UI with multiple personalities
- **🐚 Bash CLI** - Lightweight bash alternative for systems without Node

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd seantokuzo-mcp
npm install
```

### 2. Configure

```bash
# Copy the example env file
cp .env.example .env

# Edit with your GitHub token
# Get one at: https://github.com/settings/tokens
```

Or run the interactive setup:

```bash
npm run cli setup
```

### 3. Build

```bash
npm run build
```

### 4. Use!

**CLI Mode:**

```bash
# Interactive mode
npm run cli

# Specific commands
npm run cli pr create
npm run cli pr update
npm run cli pr list
npm run cli config status
```

**MCP Mode (for Claude):**
See the MCP Setup section below.

## 📁 Project Structure

```
seantokuzo-mcp/
├── src/
│   ├── index.ts              # Main entry point
│   ├── server.ts             # Express webhook server
│   ├── cli/
│   │   ├── index.ts          # CLI entry point
│   │   ├── commands/         # CLI commands (pr, config)
│   │   └── ui/               # Display utilities, messages
│   ├── mcp/
│   │   └── server.ts         # MCP server implementation
│   ├── services/
│   │   └── github.ts         # GitHub API service
│   ├── types/
│   │   └── index.ts          # TypeScript types
│   └── utils/
│       ├── config.ts         # Configuration management
│       └── logger.ts         # Logging utility
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## 🧠 MCP Setup (For Claude)

The MCP server lets Claude use your PR tools directly. Here's how to set it up:

### VS Code with Continue or GitHub Copilot

Add to your MCP settings (`.vscode/mcp.json` or VS Code settings):

```json
{
  "mcpServers": {
    "sean-mcp": {
      "command": "node",
      "args": ["/path/to/seantokuzo-mcp/dist/mcp/server.js"],
      "env": {
        "GITHUB_TOKEN": "your-github-token",
        "GITHUB_USERNAME": "your-username"
      }
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sean-mcp": {
      "command": "node",
      "args": ["/path/to/seantokuzo-mcp/dist/mcp/server.js"],
      "env": {
        "GITHUB_TOKEN": "your-github-token",
        "GITHUB_USERNAME": "your-username"
      }
    }
  }
}
```

### Available MCP Tools

Once configured, Claude can use these tools:

| Tool                  | Description                                     |
| --------------------- | ----------------------------------------------- |
| `create_pull_request` | Create a new PR with auto-generated description |
| `update_pull_request` | Update a PR's title and/or description          |
| `get_pull_request`    | Get details about a specific PR                 |
| `list_pull_requests`  | List PRs for a repository                       |
| `find_pr_for_branch`  | Find the PR for a specific branch               |

## 🌐 Webhook Server

The webhook server listens for GitHub push events and auto-updates PR descriptions.

### Start the Server

```bash
npm run start:webhook
```

### Configure GitHub Webhook

1. Go to your repo → Settings → Webhooks → Add webhook
2. **Payload URL:** `https://your-server.com/webhook/github`
3. **Content type:** `application/json`
4. **Secret:** Use the `WEBHOOK_SECRET` from your `.env`
5. **Events:** Select "Pushes" and "Pull requests"

### Local Development

For local testing, use a tool like [ngrok](https://ngrok.com/):

```bash
ngrok http 3847
```

Then use the ngrok URL as your webhook URL.

## 🎭 CLI Personalities

The CLI has three personality modes:

- **🔥 Chaotic** (default) - Fun, energetic, memes
- **💼 Professional** - Clean, minimal output
- **🧘 Zen** - Calm, philosophical vibes

Set in your `.env`:

```
CLI_PERSONALITY=chaotic  # or: professional, zen
```

## 📝 Environment Variables

| Variable                 | Required | Description                                |
| ------------------------ | -------- | ------------------------------------------ |
| `GITHUB_TOKEN`           | Yes      | GitHub Personal Access Token               |
| `GITHUB_USERNAME`        | Yes      | Your GitHub username                       |
| `WEBHOOK_PORT`           | No       | Webhook server port (default: 3847)        |
| `WEBHOOK_SECRET`         | No       | GitHub webhook secret                      |
| `CLI_PERSONALITY`        | No       | CLI personality (chaotic/professional/zen) |
| `DEFAULT_PR_BASE_BRANCH` | No       | Default target branch (default: main)      |
| `DEFAULT_PR_DRAFT`       | No       | Create draft PRs by default (true/false)   |

## 🛠️ Development

```bash
# Run CLI in dev mode (with hot reload)
npm run dev:cli

# Run MCP server in dev mode
npm run dev

# Type check
npm run typecheck

# Build
npm run build
```

## 🗺️ Roadmap

Future features planned:

- [ ] **Jira Integration** - Create/move tickets, manage subtasks
- [ ] **Confluence Integration** - Generate documentation
- [ ] **PR Reviewers** - Auto-assign reviewers
- [ ] **PR Labels** - Auto-apply labels based on changes
- [ ] **AI-Enhanced Descriptions** - Use AI for better PR descriptions

## 📜 License

MIT © Sean Tokuzo

---

_Built with 🔥 and TypeScript_
