# Bureau

A web-based IDE frontend for Claude Code CLI. Get a VS Code-like experience while using your Claude Max subscription through the official CLI. **Multi-session support lets you hot-swap between projects without losing context.**

![Bureau IDE](https://img.shields.io/badge/version-1.0.0-blue) ![License](https://img.shields.io/badge/license-MIT-green)

![Bureau Demo](docs/demo.gif)

## Features

- **Monaco Editor** - Full-featured code editor with syntax highlighting, multi-file tabs, git diff markers
- **Claude Chat** - Conversational interface with thinking indicators, tool pills, message queueing
- **Terminal** - PTY-based bash terminal with multiple tabs
- **Git Integration** - Stage, commit, push/pull with visual status
- **File Explorer** - Navigate your project with tree view
- **Session Management** - Multiple project sessions with history persistence

## Security Warning

> **Warning**: Bureau spawns shell processes and has full filesystem access within its project root. Run it only on your own machine or a trusted network. **Do not expose to the public internet.**

Bureau is designed for local development, not as a hosted service.

## Prerequisites

- **Linux** (Debian/Ubuntu recommended) or macOS
- **Node.js 18+**
- **pnpm** (`npm install -g pnpm`)
- **Claude Code CLI 2.x** - Installed and authenticated with Claude Max subscription

### Installing Claude Code CLI

```bash
# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Authenticate (requires Claude Max subscription)
claude auth login
```

## Quick Start

Try Bureau without installing services:

```bash
# Clone the repository
git clone https://github.com/gtspark/bureau.git
cd bureau

# Start Bureau
./start.sh
```

Access Bureau at: **http://localhost:5175**

Press `Ctrl+C` to stop.

## Installation (systemd)

For a persistent installation on Linux:

```bash
./services/install.sh
```

This will:
1. Install dependencies (`pnpm install`)
2. Build the project (`pnpm build`)
3. Install systemd services
4. Start Bureau

## Usage

Once running, access Bureau at: **http://localhost:5175**

### Default Ports

| Service | Port | Description |
|---------|------|-------------|
| Web UI | 5175 | Frontend (Vite preview) |
| Backend | 3006 | API + WebSocket server |

### Managing Services

```bash
# Check status
sudo systemctl status bureau-server bureau-web

# Restart services
sudo systemctl restart bureau-server bureau-web

# View logs
sudo journalctl -u bureau-server -f
sudo journalctl -u bureau-web -f

# Stop services
sudo systemctl stop bureau-server bureau-web
```

### Changing Project Root

By default, Bureau uses the installation directory. To change the project root:

```bash
sudo systemctl edit bureau-server
```

Add under `[Service]`:
```ini
Environment=PROJECT_ROOT=/path/to/your/project
```

Then restart:
```bash
sudo systemctl restart bureau-server
```

## Architecture

Bureau wraps the Claude Code CLI rather than calling the API directly. This means:

- ✅ No API keys to manage
- ✅ No token refresh logic
- ✅ Automatic compatibility with Claude Code updates
- ✅ Uses your existing Claude Max subscription

```
Browser (React)              Server (Node.js)
┌──────────────────────┐     ┌─────────────────────────────┐
│ Monaco Editor        │     │ Express + WebSocket         │
│ Chat Interface       │◄───►│ node-pty (terminals)        │
│ File Explorer        │     │ chokidar (file watching)    │
│ Terminal             │     │ simple-git (git ops)        │
└──────────────────────┘     └─────────────────────────────┘
                                        │
                                        ▼
                              Claude Code CLI (`claude`)
                                        │
                              (CLI handles API auth & calls)
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` | Save file |
| `Ctrl+F` | Find in file |
| `Enter` | Send message to Claude |
| `Shift+Enter` | New line in chat |

## Troubleshooting

### Claude not responding

1. Check if Claude CLI is authenticated:
   ```bash
   claude auth status
   ```

2. Check server logs:
   ```bash
   sudo journalctl -u bureau-server -n 50
   ```

### "Session ID already in use" error

This can happen after a crash. Restart the services:
```bash
sudo systemctl restart bureau-server bureau-web
```

### Git push fails with "origin does not exist"

You need to configure a remote first:
```bash
git remote add origin git@github.com:you/repo.git
```

## Development

Bureau uses a monorepo structure:

```
bureau/
├── packages/
│   ├── server/    # Node.js backend
│   └── web/       # React frontend
├── services/      # systemd service files
└── package.json
```

To make changes:

```bash
# Edit files in packages/server/src or packages/web/src

# Build
pnpm build

# Restart services
sudo systemctl restart bureau-server bureau-web
```

## HTTPS Setup

Bureau runs over HTTP by default. For HTTPS (required for clipboard API), use a reverse proxy like nginx or Caddy. See [this guide](https://www.digitalocean.com/community/tutorials/how-to-configure-nginx-as-a-reverse-proxy-on-ubuntu-22-04) for nginx setup, or use [Caddy](https://caddyserver.com/) for automatic SSL:

```
bureau.example.com {
    reverse_proxy /ws 127.0.0.1:3006
    reverse_proxy * 127.0.0.1:5175
}
```

## Privacy

Bureau is designed with privacy in mind:

- **No telemetry** - Zero analytics or tracking
- **Local only** - All data stays on your machine
- **No external calls** - Only communicates with Claude CLI

Data is stored in `~/.bureau/`:
- `sessions.json` - Session metadata
- `history/` - Chat history (JSONL files)

## Compatibility

Tested with Claude Code CLI version **2.0.x**. The stream-json format may change in future CLI versions - if you encounter issues after a CLI update, please open an issue.

## License

MIT - See [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome! Please open an issue or PR.

## Acknowledgments

- [Monaco Editor](https://microsoft.github.io/monaco-editor/)
- [xterm.js](https://xtermjs.org/)
- [Claude Code CLI](https://claude.ai/code)
