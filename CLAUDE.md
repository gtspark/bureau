# Bureau

Bureau is a web-based IDE that wraps Claude Code CLI, giving you a VS Code-like experience while using your Claude Max subscription.

## Features

- **Monaco Editor** - Full-featured code editor with syntax highlighting
- **Chat Panel** - Interact with Claude directly in the IDE
- **Terminal** - Integrated bash terminal
- **File Explorer** - Browse and manage project files
- **Git Integration** - Stage, commit, push/pull from the UI
- **Sessions** - Multiple chat sessions with history persistence

## Requirements

- Node.js 18+
- pnpm
- Claude Code CLI (installed and authenticated)
- Claude Max subscription

## Quick Start

```bash
# Clone the repository
git clone https://github.com/your-username/bureau.git
cd bureau

# Install and start
./services/install.sh

# Open in browser
open http://localhost:5175
```

## Configuration

### Changing the Project Root

By default, Bureau works in its own directory. To work on a different project:

```bash
sudo systemctl edit bureau-server
```

Add:
```ini
[Service]
Environment=PROJECT_ROOT=/path/to/your/project
```

Then restart:
```bash
sudo systemctl restart bureau-server
```

### Ports

- **5175** - Web UI
- **3006** - Backend API

To change ports, edit the systemd service files in `/etc/systemd/system/`.

## Usage

### Chat

Type messages in the chat panel to interact with Claude. Claude can:
- Read and edit files in your project
- Run terminal commands
- Search code with grep/glob
- Help with git operations

### Sessions

Create multiple sessions to organize different tasks. Sessions persist your chat history.

### Terminal

The terminal tab gives you a full bash shell. The "Output" tab shows command output from Claude's actions.

### Git

The git panel (folder icon in sidebar) shows:
- Staged changes
- Unstaged changes
- Untracked files

Click files to stage/unstage, then commit with a message.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` | Save current file |
| `Ctrl+Enter` | Send chat message |
| `Escape` | Stop Claude's response |

## Troubleshooting

### Claude CLI not detected

Make sure Claude Code CLI is installed:
```bash
npm install -g @anthropic-ai/claude-code
```

Then authenticate:
```bash
claude
```

### Services not starting

Check logs:
```bash
sudo journalctl -u bureau-server -f
sudo journalctl -u bureau-web -f
```

### Permission issues

Bureau needs read/write access to your project directory.

## Architecture

Bureau runs as two services:
- **bureau-server** - Node.js backend handling WebSocket connections, file operations, and spawning Claude CLI
- **bureau-web** - Vite preview server for the React frontend

All communication with Claude happens through the official CLI - Bureau never touches the Anthropic API directly.

## License

MIT
