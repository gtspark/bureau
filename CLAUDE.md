# Bureau

A web-based GUI frontend for Claude Code CLI. Provides split-pane IDE experience while using your Claude Max subscription through the official CLI.

## Architecture

Bureau is a **wrapper around Claude Code CLI**, not a direct API client. Claude Code handles authentication, rate limits, and API communication. Bureau provides the UI.

```
Browser (React)              Pi 5 Server (Node.js)
┌──────────────────────┐     ┌─────────────────────────────┐
│ File Tree            │     │ Express + WebSocket         │
│ Monaco Editor        │◄───►│ node-pty (spawns `claude`)  │
│ Chat Pane            │     │ chokidar (file watching)    │
│ Terminal Pane        │     │ simple-git (git operations) │
│ Git Status           │     │ File System Access          │
└──────────────────────┘     └─────────────────────────────┘
                                        │
                                        ▼
                              Claude Code CLI (`claude`)
                                        │
                                        ▼
                              Anthropic API (Max subscription)
```

## Why This Approach

Direct OAuth was blocked by Anthropic (June 2025). The Claude Code CLI credential is locked to the CLI only. Rather than fighting this, Bureau embraces it - spawning the CLI as a subprocess and providing a nice GUI around it.

Benefits:
- No auth code to maintain
- No token refresh logic
- Automatic compatibility with Claude Code updates
- Uses official, sanctioned access method

## Tech Stack

### Backend (packages/server)
- **Node.js + Express** - HTTP server
- **ws** - WebSocket for real-time updates
- **node-pty** - Spawn PTY terminals and Claude CLI
- **chokidar** - File system watching
- **simple-git** - Git operations

### Frontend (packages/web)
- **React 18 + Vite** - UI framework
- **Tailwind CSS** - Styling
- **Monaco Editor** - Code editing
- **xterm.js** - Terminal emulation (with fit and clipboard addons)
- **react-markdown** - Render Claude's markdown responses

## Project Structure

```
bureau/
├── packages/
│   ├── server/
│   │   ├── src/
│   │   │   ├── index.ts              # Express + WebSocket setup, message routing
│   │   │   ├── claude/
│   │   │   │   └── process.ts        # Spawn and manage Claude CLI (stream-json mode)
│   │   │   ├── files/
│   │   │   │   ├── watcher.ts        # chokidar file watching
│   │   │   │   ├── operations.ts     # read/write/list files
│   │   │   │   └── git.ts            # simple-git wrapper
│   │   │   ├── sessions/
│   │   │   │   ├── manager.ts        # Session lifecycle, Claude process per session
│   │   │   │   ├── history.ts        # Chat history persistence (~/.bureau/)
│   │   │   │   ├── types.ts          # Session type definitions
│   │   │   │   └── index.ts          # Re-exports
│   │   │   └── terminal/
│   │   │       └── pty.ts            # PTY terminal management
│   │   ├── dist/                     # Compiled output (systemd runs this)
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web/
│       ├── src/
│       │   ├── App.tsx               # Root component, layout orchestration
│       │   ├── main.tsx              # Entry point
│       │   ├── components/
│       │   │   ├── Layout.tsx        # Resizable split pane container
│       │   │   ├── Sidebar.tsx       # Activity bar + file tree/git panels
│       │   │   ├── FileTree.tsx      # Directory browser with expand/collapse
│       │   │   ├── Editor.tsx        # Monaco wrapper
│       │   │   ├── Chat.tsx          # Claude conversation UI
│       │   │   ├── Terminal.tsx      # xterm.js with PTY + Output tabs
│       │   │   ├── GitStatus.tsx     # Staged/unstaged/untracked files
│       │   │   ├── SessionSwitcher.tsx   # Session dropdown in chat header
│       │   │   ├── NewSessionModal.tsx   # Create session dialog
│       │   │   └── Header.tsx        # Top bar (unused currently)
│       │   ├── contexts/
│       │   │   ├── WebSocketContext.tsx  # WS connection, Claude state tracking
│       │   │   └── SessionContext.tsx    # Active session management
│       │   ├── types/
│       │   │   └── session.ts        # Frontend session types
│       │   └── lib/
│       │       └── cn.ts             # Tailwind class merge utility
│       ├── dist/                     # Built output (vite preview serves this)
│       ├── package.json
│       ├── vite.config.ts
│       └── tsconfig.json
├── package.json
├── pnpm-workspace.yaml
└── CLAUDE.md
```

## Claude CLI Integration

Bureau uses Claude Code CLI in **stream-json mode** for structured bidirectional communication:

```typescript
const args = [
  '-p',                              // Print mode
  '--verbose',                       // Required for stream-json
  '--input-format', 'stream-json',   // JSON input on stdin
  '--output-format', 'stream-json',  // JSON output on stdout
  '--dangerously-skip-permissions',  // Skip permission prompts for web UI
  '-r', sessionId                    // Resume existing session (or --session-id for new)
];

spawn('claude', args, { cwd: projectRoot });
```

### Message Types from Claude CLI

- `system` (subtype: `init`) - Session started, includes `cwd` and available tools
- `assistant` - Claude's response, `content` array contains `text`, `tool_use`, `thinking` blocks
- `user` - Tool results, `content` array contains `tool_result` blocks
- `result` - Turn complete, includes final text and usage stats

### Session Persistence

- Bureau session IDs → Claude session IDs via MD5 hash (avoids conflicts with manual CLI usage)
- Session data stored in `~/.bureau/sessions.json`
- Chat history stored in `~/.bureau/history/<session-id>.jsonl`
- Initialized sessions tracked in `~/.bureau/initialized-sessions.json`

## Running Bureau

Bureau runs as two systemd services. **There is no dev mode.**

| Service | Port | Description |
|---------|------|-------------|
| bureau-server | 3006 | Node.js backend (Express + WebSocket) |
| bureau-web | 5175 | Static frontend (Vite preview server) |

### Making Changes

```bash
# 1. Edit source files in packages/server/src or packages/web/src
# 2. Build
pnpm build

# 3. Restart services
sudo systemctl restart bureau-server bureau-web

# 4. Check status
sudo systemctl status bureau-server bureau-web
```

### Viewing Logs

```bash
sudo journalctl -u bureau-server -f
sudo journalctl -u bureau-web -f
```

### Service Files

Located in `/etc/systemd/system/`:
- `bureau-server.service`
- `bureau-web.service`

To change PROJECT_ROOT:
```bash
sudo systemctl edit bureau-server
# Add under [Service]:
# Environment=PROJECT_ROOT=/new/path/to/project
sudo systemctl restart bureau-server
```

## WebSocket Protocol

### Client → Server

```typescript
// Send message to Claude
{ type: 'claude:input', text: 'fix the bug in auth.ts' }

// File operations
{ type: 'file:save', path: '/src/auth.ts', content: '...' }
{ type: 'files:list', path: '/src' }
{ type: 'file:read', path: '/src/auth.ts' }

// Git operations
{ type: 'git:status' }
{ type: 'git:stage', path: 'file.ts' }
{ type: 'git:unstage', path: 'file.ts' }

// Terminal (PTY)
{ type: 'pty:spawn', cols: 80, rows: 24 }
{ type: 'pty:input', id: 'pty-1', data: 'ls -la\r' }
{ type: 'pty:resize', id: 'pty-1', cols: 120, rows: 40 }
{ type: 'pty:kill', id: 'pty-1' }

// Sessions
{ type: 'sessions:list' }
{ type: 'sessions:create', name: 'my-project', projectRoot: '/path' }
{ type: 'sessions:switch', id: 'uuid' }
{ type: 'sessions:delete', id: 'uuid' }
```

### Server → Client

```typescript
// Claude messages (forwarded from CLI stdout)
{ type: 'claude:message', message: { type: 'assistant', ... } }
{ type: 'claude:spawned' }
{ type: 'claude:exit', code: 0 }
{ type: 'claude:error', message: '...' }

// File events
{ type: 'file:changed', path: '/src/auth.ts' }
{ type: 'files:list', files: [...] }

// Git events
{ type: 'git:status', staged: [...], unstaged: [...], untracked: [...] }

// Terminal events
{ type: 'pty:spawned', id: 'pty-1' }
{ type: 'pty:data', id: 'pty-1', data: '...' }
{ type: 'pty:exit', id: 'pty-1', code: 0 }

// Session events
{ type: 'sessions:list', sessions: [...] }
{ type: 'sessions:switched', session: {...}, claudeRunning: true }
{ type: 'connected', claudeRunning: true, session: {...} }
```

## Environment Variables

```bash
PORT=3006           # Server port (default: 3006)
PROJECT_ROOT=/path  # Working directory for Claude and file operations
```

## Critical Rules

1. **No telemetry** - Zero analytics, tracking, or external calls except Claude CLI
2. **Local only** - All data stays on disk
3. **No auth code** - Claude CLI handles authentication
4. **systemd only** - No dev mode, always build then restart services
5. **MIT License** - Open source

## Model Info (for reference)

Claude Code CLI uses these models via Max subscription:
- claude-sonnet-4-5-20250929 (default)
- claude-opus-4-5-20251101 (if you have Max 20x)

Bureau doesn't need to know about models - the CLI handles selection.

## Known Issues / TODO

### Needs Verification
- Symlinks may still show as files in file tree
- Session persistence across server restarts

### Future
- Multi-tab editor support (read-only tabs from Claude file reads)
- Better thinking block UI (currently expandable accordion)

## Recent Fixes (Dec 2025)

- **Tool ordering**: Tools now display before the message text (fixed via toolsSnapshot capture)
- **claudeCwd sync**: Terminal sync button now correctly tracks Claude's working directory by parsing absolute paths from tool_use inputs (Bash commands, file paths in Read/Edit/Write/Glob/Grep)
- **Terminal copy**: Auto-copy on selection now works over HTTP using execCommand fallback (navigator.clipboard requires HTTPS)
- **Tool icon alignment**: Icons now consistently sized at w-6 h-6
- **Tool pill scroll-to-line**: Clicking a tool pill in chat scrolls to the exact command line in output terminal (not bottom)

## Working Rules for Claude Code

### Before ANY Session

Start every session by reading this file and answering:
1. What are the systemd service states? (`systemctl is-active bureau-server bureau-web`)
2. Is there a current error? What is it?
3. What was I asked to do?

Do not proceed until you can answer all three.

### Planning Required

For any change that touches more than one file OR involves debugging:

1. **Read first** - Read all relevant files before proposing changes
2. **Write a plan** - State the numbered steps you will take
3. **Wait for approval** - Do not execute until user confirms
4. **One step at a time** - Implement step 1, show result, wait for confirmation before step 2

Example:
```
I've read the relevant files. Here's my plan:

1. Fix the import in index.ts (line 34)
2. Update the type definition in types.ts
3. Build and restart services

Should I proceed with step 1?
```

### Build/Deploy Process

There is **one way** to deploy changes:
```bash
pnpm build && sudo systemctl restart bureau-server bureau-web
```

**NEVER:**
- Run `pnpm dev` 
- Spawn background processes
- Disable systemd services
- Start temporary servers

### When Something Breaks

1. **Stop** - Do not immediately try to fix
2. **Check logs** - `sudo journalctl -u bureau-server -n 50 --no-pager`
3. **Identify root cause** - State what the actual error is
4. **Propose fix** - Explain what you'll change and why
5. **Wait for approval** - Do not execute until confirmed

### Context Management

After completing a task successfully:
- User may run `/clear` to reset context
- This is good - it removes failed attempts and confusion
- The next session starts fresh with this CLAUDE.md as ground truth

If context feels polluted (going in circles, repeating mistakes):
- Stop and say "I think we should /clear and start fresh on this task"
- Summarize what we learned before clearing

### What NOT to Do

- Don't hallucinate file contents - read them first
- Don't assume previous session states - check them
- Don't chain multiple fixes without verification between each
- Don't delete or modify things to "make errors go away" without understanding why
- Don't say "I understand" then immediately contradict that understanding
- Don't run commands while claiming to be "just planning"

### Thinking and Reasoning

For complex tasks, use thinking triggers:
- "think" - basic extended thinking
- "think hard" - more compute budget  
- "think harder" - even more
- "ultrathink" - maximum reasoning

Prefer longer thinking over faster action. Getting it right once beats debugging five attempts.
