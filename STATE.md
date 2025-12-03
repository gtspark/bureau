# STATE.md - Server Code Analysis

## File Summaries

### packages/server/src/index.ts
Main Express + WebSocket server. Responsibilities:
- Express server on port 3006 with CORS, health check (`/api/health`), config endpoint (`/api/config`)
- WebSocket server on `/ws` path
- Initializes singleton managers: `SessionManager`, `FileWatcher`, `PtyManager`, `GitOperations`
- Tracks client state via two Maps:
  - `clientPtyMap`: WebSocket → Set of PTY IDs (terminals owned by client)
  - `clientSessionMap`: WebSocket → session ID (which Bureau session client is viewing)
- Forwards events from managers to relevant WebSocket clients
- Handles all WebSocket message routing (sessions, claude, files, git, pty)
- On startup: creates default session if none exist, auto-spawns Claude for active session
- Graceful shutdown handlers for SIGINT/SIGTERM

### packages/server/src/sessions/types.ts
TypeScript type definitions:
- `SessionStatus`: 'running' | 'stopped' | 'error'
- `OutputEntry`: { timestamp, type: 'user'|'claude'|'system', content }
- `Session`: { id, name, projectRoot, createdAt, lastActiveAt, status }
- `SessionWithHistory`: Session + history array
- `SessionsFile`: Disk format for sessions.json

### packages/server/src/sessions/index.ts
Barrel export file - re-exports types.ts, history.ts, manager.ts

### packages/server/src/sessions/history.ts
Manages per-session chat history persistence:
- Storage: `~/.bureau/history/{sessionId}.jsonl` (JSON Lines format)
- `HistoryManager` class:
  - `append(entry)`: Appends OutputEntry to file, auto-trims if > 15000 lines
  - `load(limit=10000)`: Reads last N entries from file
  - `trim()`: Keeps only last 10000 lines
  - `clear()`: Deletes all history for session
  - `static delete(sessionId)`: Deletes history file

### packages/server/src/sessions/manager.ts
Central session management singleton:
- State:
  - `sessions`: Map<sessionId, Session>
  - `claudeProcesses`: Map<sessionId, ClaudeProcess>
  - `historyManagers`: Map<sessionId, HistoryManager>
  - `activeSessionId`: string | null
- Disk persistence: `~/.bureau/sessions.json`
- Key methods:
  - `createSession(name, projectRoot)`: Creates new session, saves to disk
  - `switchSession(id)`: Changes active session, returns session with history
  - `getActiveSessionWithHistory(limit=500)`: Loads session + last 500 history entries
  - `spawnClaudeProcess(sessionId)`: Spawns Claude, wires up event forwarding + history recording
  - `killClaudeProcess(sessionId)`: Kills Claude process
  - `sendMessageToClaude(sessionId, text)`: Records to history, forwards to Claude
- Event emission: session:created, session:switched, session:renamed, session:deleted, claude:message, claude:exit, claude:error

### packages/server/src/claude/process.ts
Manages individual Claude CLI subprocess:
- PID tracking: `~/.bureau/claude-pids.json` (maps sessionId → PID)
- Session ID mapping: `~/.bureau/session-map.json` (maps Bureau sessionId → Claude sessionId via MD5 hash)
- `ClaudeProcess` class (extends EventEmitter):
  - `spawn()`:
    1. Calls `killTrackedPid(sessionId)` to kill previous process for THIS session
    2. Generates deterministic Claude session ID via MD5 hash
    3. Spawns `claude -p --verbose --input-format stream-json --output-format stream-json --session-id {claudeSessionId} --dangerously-skip-permissions`
    4. Tracks new PID to disk
    5. Parses stdout JSON lines, emits 'message' events
    6. Handles stderr, exit, error events
  - `sendMessage(text)`: Writes stream-json formatted message to stdin
  - `kill()`: Kills process
  - `respawn()`: Kills then spawns
- Shutdown handlers: SIGINT/SIGTERM kill Claude process

---

## Answers to Questions

### 1. Is outputHistory being written to disk? Where?

**Yes.** Written to `~/.bureau/history/{sessionId}.jsonl`

Written in two places in `manager.ts`:
1. Line 181-191: When Claude emits a message, it's recorded:
   ```typescript
   claude.on('message', (message) => {
     historyManager.append({ timestamp, type: 'claude', content: JSON.stringify(message) });
   });
   ```
2. Line 256-264: When user sends a message:
   ```typescript
   sendMessageToClaude(sessionId, text) {
     historyManager.append({ timestamp, type: 'user', content: text });
     claude.sendMessage(text);
   }
   ```

### 2. What happens in the WebSocket 'connection' handler?

`index.ts:160-184`:

1. Log "Client connected"
2. Get active session (or create "Default" session if none exists)
3. Associate client with active session via `clientSessionMap.set(ws, activeSession.id)`
4. Load session with last 500 history entries via `getActiveSessionWithHistory()`
5. Check if Claude is running for this session
6. Send `connected` message to client containing:
   - `session`: Full session object with history array
   - `claudeRunning`: boolean
   - `sessions`: List of all sessions

**Key point:** History IS replayed on connection. The client receives the last 500 entries.

### 3. What happens in the WebSocket 'close' handler?

`index.ts:610-622`:

1. Log "Client disconnected"
2. Kill all PTYs owned by this client (terminal sessions)
3. Remove client from `clientPtyMap`
4. Remove client from `clientSessionMap`

**Key point:** Claude process is NOT killed on client disconnect. It keeps running.

### 4. When is Claude spawned? When is it killed?

**Spawned:**
1. Server startup (`index.ts:638-646`): Auto-spawns for active session
2. `claude:input` message (`index.ts:299-318`): Auto-spawns if not running, then sends message
3. `claude:spawn` message (`index.ts:326-357`): Explicit spawn request

**Killed:**
1. `claude:kill` message (`index.ts:360-369`): Explicit kill request
2. Session deletion (`manager.ts:148`): Kills Claude before deleting session
3. `spawnClaudeProcess()` (`manager.ts:175`): Kills existing before spawning new
4. Server shutdown (`manager.ts:301-306`): Kills all Claude processes
5. `killTrackedPid()` (`process.ts:71-84`): Kills by PID from disk on spawn attempt

**NOT killed:**
- Client WebSocket disconnect (Claude keeps running)
- Browser refresh (Claude keeps running)

### 5. Is there any reconnection logic?

**Yes, partially:**

On reconnection (new WebSocket connection):
- Server loads session + history from disk
- Server sends history to client in `connected` message
- Client can render past conversation

**BUT there's a problem:**

If Claude was running before disconnect:
1. Claude process is still alive (not killed on disconnect)
2. `clientSessionMap` was cleared for old connection
3. New connection gets associated with session
4. If client sends `claude:input`:
   - `isClaudeRunning(sessionId)` returns `true` (process exists in `claudeProcesses` Map)
   - Message is sent to existing Claude process
   - **This actually works correctly!**

Wait - let me re-examine. The `claudeProcesses` Map in SessionManager persists across WebSocket connections. So:
- Disconnect doesn't clear `claudeProcesses`
- Reconnect associates new WebSocket with same session
- `sendMessageToClaude()` uses the existing ClaudeProcess from `claudeProcesses` Map

**The session ID conflict happens on SERVER RESTART, not browser refresh.**

On server restart:
1. Claude processes from old server are orphaned (still running)
2. New server tries to spawn Claude with same session ID
3. Claude CLI rejects: "Session ID already in use"
4. `killTrackedPid()` tries to kill by PID, but:
   - The PID file may be stale
   - Or the PID changed
   - Or process was spawned by different server instance

---

## Current Problem: Session ID Conflict

**Root cause:** `killTrackedPid()` in `process.ts:71-84` relies on stored PIDs, which can be stale after crashes or unclean shutdowns.

**Current kill logic:**
```typescript
function killTrackedPid(sessionId: string): void {
  const pids = loadTrackedPids();  // from ~/.bureau/claude-pids.json
  const pid = pids[sessionId];
  if (pid) {
    process.kill(pid, 'SIGTERM');  // Kill by PID
    delete pids[sessionId];
    saveTrackedPids(pids);
  }
}
```

**Why it fails:**
- If server crashed, PID file wasn't updated
- If Claude process crashed and respawned externally, PID changed
- If PID was reused by another process, wrong process gets killed

**Proposed fix:** Kill by command pattern instead of PID:
```typescript
execSync(`pkill -9 -f "claude --session-id ${claudeSessionId}"`);
```

This targets the exact Claude process with that session ID, regardless of PID.

---

## Data Flow Summary

```
Browser                     Server                      Claude CLI
   |                           |                            |
   |-- WS connect ------------>|                            |
   |<-- connected + history ---|                            |
   |                           |                            |
   |-- claude:input ---------->|                            |
   |                           |-- spawn if needed -------->|
   |                           |-- write to stdin --------->|
   |                           |<-- stdout JSON lines ------|
   |                           |-- append to history        |
   |<-- claude:message --------|                            |
   |                           |                            |
   |-- WS disconnect           |                            |
   |   (Claude keeps running)  |                            |
   |                           |                            |
   |-- WS reconnect ---------->|                            |
   |<-- connected + history ---|                            |
   |                           |   (reuses existing Claude) |
```

---

## Files on Disk

| Path | Content |
|------|---------|
| `~/.bureau/sessions.json` | Session metadata (id, name, projectRoot, status) |
| `~/.bureau/history/{sessionId}.jsonl` | Chat history (JSON Lines) |
| `~/.bureau/claude-pids.json` | PID tracking for kill-on-restart |
| `~/.bureau/session-map.json` | Bureau sessionId → Claude sessionId mapping |
