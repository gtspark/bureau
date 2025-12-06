# Changelog

All notable changes to Bureau will be documented in this file.

## [1.0.0] - 2024-12-06

### Added
- **Claude Integration** - Chat interface with Claude Code CLI using stream-json mode
- **Monaco Editor** - Multi-file editor with syntax highlighting and tabs
- **Git Integration** - Stage, unstage, commit, push, pull with visual status
- **Git Diff Highlighting** - Green gutter markers for changed lines
- **Terminal** - PTY-based bash terminal with multiple tabs
- **Output Panel** - Read-only view of Claude's command output
- **File Explorer** - Tree navigation with expand/collapse
- **Session Management** - Multiple project sessions with history persistence
- **Auto-file Opening** - Files open automatically when Claude edits them
- **Message Queueing** - Queue messages while Claude is processing
- **Tool Pills** - Visual display of Claude's tool usage with click-to-scroll
- **Thinking Indicator** - Shows when Claude is thinking
- **Context Compaction** - Handles Claude's context window management
- **Toast Notifications** - Success/error feedback for git operations
- **HTTPS Documentation** - nginx/Caddy reverse proxy configuration
- **CLI Status Detection** - Graceful handling when Claude CLI is not installed or authenticated
- **Setup Instructions** - In-app guidance for installing and authenticating Claude CLI

### Technical
- Node.js backend with Express + WebSocket
- React frontend with Vite
- systemd service integration
- Session persistence in `~/.bureau/`

## [Unreleased]

### Planned
- Settings modal (font sizes, theme)
- Command palette (Ctrl+P)
- Full-text search panel
- Mobile responsiveness
