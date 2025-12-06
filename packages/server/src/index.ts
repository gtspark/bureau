import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { getFileWatcher, stopFileWatcher, FileChangeEvent } from './files/watcher.js';
import { getFileOperations } from './files/operations.js';
import { getGitOperations } from './files/git.js';
import { getPtyManager, shutdownPtyManager } from './terminal/pty.js';
import { getSessionManager, shutdownSessionManager, Session } from './sessions/index.js';
import { getCachedClaudeCliStatus, refreshClaudeCliStatus } from './claude/process.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3006;
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();

const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Config endpoint - returns current project root
app.get('/api/config', (_req, res) => {
  res.json({
    projectRoot: PROJECT_ROOT,
    port: PORT,
  });
});

// Claude CLI status endpoint
app.get('/api/claude/status', (_req, res) => {
  const status = getCachedClaudeCliStatus();
  res.json(status);
});

// Refresh Claude CLI status (after user installs/authenticates)
app.post('/api/claude/refresh', (_req, res) => {
  const status = refreshClaudeCliStatus();
  // Broadcast new status to all connected clients
  broadcast({ type: 'claude:cli:status', ...status });
  res.json(status);
});

const server = createServer(app);

// WebSocket server
const wss = new WebSocketServer({ server, path: '/ws' });

// Initialize session manager (replaces old singleton Claude process)
const sessionManager = getSessionManager();

// Initialize file watcher
const fileWatcher = getFileWatcher(PROJECT_ROOT);

// Default file operations (fallback)
const defaultFileOps = getFileOperations(PROJECT_ROOT);

// Get file operations for a client's session
function getClientFileOps(ws: WebSocket): ReturnType<typeof getFileOperations> {
  const sessionId = clientSessionMap.get(ws);
  if (sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (session) {
      return getFileOperations(session.projectRoot);
    }
  }
  return defaultFileOps;
}

// Track current working directory per client (for explorer/git)
const clientCwdMap = new Map<WebSocket, string>();

// Get git operations for a client's current working directory
function getClientGitOps(ws: WebSocket): ReturnType<typeof getGitOperations> {
  const cwd = clientCwdMap.get(ws);
  if (cwd) {
    return getGitOperations(cwd);
  }
  // Fall back to session's projectRoot, then default
  const sessionId = clientSessionMap.get(ws);
  if (sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (session) {
      return getGitOperations(session.projectRoot);
    }
  }
  return getGitOperations(PROJECT_ROOT);
}

// Get current working directory for a client
function getClientCwd(ws: WebSocket): string {
  const cwd = clientCwdMap.get(ws);
  if (cwd) return cwd;
  const sessionId = clientSessionMap.get(ws);
  if (sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (session) return session.projectRoot;
  }
  return PROJECT_ROOT;
}

// Initialize PTY manager for interactive terminals
const ptyManager = getPtyManager(PROJECT_ROOT);

// Track which WebSocket client owns which PTY
const clientPtyMap = new Map<WebSocket, Set<string>>();

// Track which session each client is viewing
const clientSessionMap = new Map<WebSocket, string>();

// Track which PTY belongs to which session (for cwd persistence)
const ptySessionMap = new Map<string, string>();

// Forward PTY output to owning client
ptyManager.on('data', ({ id, data }: { id: string; data: string }) => {
  wss.clients.forEach((client) => {
    const ptyIds = clientPtyMap.get(client);
    if (ptyIds?.has(id) && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'pty:data', id, data }));
    }
  });
});

ptyManager.on('exit', ({ id, exitCode }: { id: string; exitCode: number }) => {
  wss.clients.forEach((client) => {
    const ptyIds = clientPtyMap.get(client);
    if (ptyIds?.has(id)) {
      ptyIds.delete(id);
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'pty:exit', id, exitCode }));
      }
    }
  });
  // Clean up pty-session mapping
  ptySessionMap.delete(id);
});

// Track terminal cwd changes and persist to session
ptyManager.on('cwd', ({ id, cwd }: { id: string; cwd: string }) => {
  const sessionId = ptySessionMap.get(id);
  if (sessionId) {
    sessionManager.updateTerminalCwd(sessionId, cwd);
    // Also notify clients so they can update UI if needed
    wss.clients.forEach((client) => {
      const clientSession = clientSessionMap.get(client);
      if (clientSession === sessionId && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'pty:cwd', id, cwd, sessionId }));
      }
    });
  }
});

// Forward file changes to all clients
fileWatcher.on('change', (event: FileChangeEvent) => {
  console.log(`File ${event.event}: ${event.path}`);
  broadcast({
    type: 'file:changed',
    path: event.path,
    event: event.event,
    content: event.content,
  });
});

fileWatcher.on('error', (error: Error) => {
  console.error('File watcher error:', error);
});

// Broadcast to all connected clients
function broadcast(message: object): void {
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// Forward Claude messages to ALL clients (they route by sessionId on frontend)
// This allows background sessions to keep receiving messages when user switches away
sessionManager.on('claude:message', ({ sessionId, message }: { sessionId: string; message: object }) => {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'claude:message', sessionId, message }));
    }
  });
});

sessionManager.on('claude:exit', ({ sessionId, code }: { sessionId: string; code: number }) => {
  console.log(`Claude process exited for session ${sessionId} with code ${code}`);
  wss.clients.forEach((client) => {
    const clientSession = clientSessionMap.get(client);
    if (clientSession === sessionId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'claude:exit', sessionId, code }));
    }
  });
});

sessionManager.on('claude:error', ({ sessionId, message }: { sessionId: string; message: string }) => {
  console.error(`Claude error for session ${sessionId}:`, message);
  wss.clients.forEach((client) => {
    const clientSession = clientSessionMap.get(client);
    if (clientSession === sessionId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'claude:error', sessionId, message }));
    }
  });
});

sessionManager.on('claude:compacted', ({ sessionId, trigger, preTokens }: { sessionId: string; trigger: string; preTokens: number }) => {
  console.log(`Context compacted for session ${sessionId}: trigger=${trigger}, preTokens=${preTokens}`);
  wss.clients.forEach((client) => {
    const clientSession = clientSessionMap.get(client);
    if (clientSession === sessionId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'claude:compacted', sessionId, trigger, preTokens }));
    }
  });
});

// Broadcast session changes to all clients
sessionManager.on('session:created', (session: Session) => {
  broadcast({ type: 'sessions:created', session });
});

sessionManager.on('session:renamed', (session: Session) => {
  broadcast({ type: 'sessions:renamed', session });
});

sessionManager.on('session:deleted', ({ id, name }: { id: string; name: string }) => {
  broadcast({ type: 'sessions:deleted', id, name });
});

// Handle WebSocket connections
wss.on('connection', async (ws: WebSocket) => {
  console.log('Client connected');

  // Queue to hold messages that arrive before setup is complete
  const pendingMessages: Buffer[] = [];
  let setupComplete = false;

  // Attach message handler FIRST to avoid race condition
  ws.on('message', async (rawData: Buffer) => {
    // If setup isn't complete, queue the message
    if (!setupComplete) {
      console.log('Queuing message received during setup');
      pendingMessages.push(rawData);
      return;
    }
    await handleMessage(rawData);
  });

  // Helper function to process messages
  const handleMessage = async (rawData: Buffer) => {
    const message = rawData.toString();
    console.log('Received message:', message.substring(0, 200));

    try {
      const parsed = JSON.parse(message);
      const clientSessionId = clientSessionMap.get(ws);

      switch (parsed.type) {
        // Session handlers
        case 'sessions:list': {
          ws.send(JSON.stringify({
            type: 'sessions:list',
            sessions: sessionManager.listSessions(),
          }));
          break;
        }

        case 'sessions:create': {
          // createSession() emits 'session:created' which broadcasts to all clients
          // so no need to send a direct response here
          sessionManager.createSession(
            parsed.name || '',
            parsed.projectRoot || PROJECT_ROOT
          );
          break;
        }

        case 'sessions:switch': {
          const sessionWithHistory = await sessionManager.switchSession(parsed.id);
          if (sessionWithHistory) {
            clientSessionMap.set(ws, parsed.id);
            const isRunning = sessionManager.isClaudeRunning(parsed.id);
            ws.send(JSON.stringify({
              type: 'sessions:switched',
              session: sessionWithHistory,
              claudeRunning: isRunning,
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Session not found',
              originalType: parsed.type,
            }));
          }
          break;
        }

        case 'sessions:rename': {
          const session = sessionManager.renameSession(parsed.id, parsed.name);
          if (session) {
            ws.send(JSON.stringify({
              type: 'sessions:renamed',
              session,
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Session not found',
              originalType: parsed.type,
            }));
          }
          break;
        }

        case 'sessions:delete': {
          const deleted = sessionManager.deleteSession(parsed.id);
          if (deleted) {
            // Update client session if they were viewing deleted session
            if (clientSessionMap.get(ws) === parsed.id) {
              const newActive = sessionManager.getActiveSession();
              if (newActive) {
                clientSessionMap.set(ws, newActive.id);
              }
            }
            ws.send(JSON.stringify({
              type: 'sessions:deleted',
              id: parsed.id,
              activeSession: sessionManager.getActiveSession(),
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Session not found',
              originalType: parsed.type,
            }));
          }
          break;
        }

        case 'sessions:active': {
          const active = await sessionManager.getActiveSessionWithHistory();
          ws.send(JSON.stringify({
            type: 'sessions:active',
            session: active,
            claudeRunning: active ? sessionManager.isClaudeRunning(active.id) : false,
          }));
          break;
        }

        // Claude handlers (now session-aware)
        case 'claude:input': {
          if (!clientSessionId) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'No active session',
              originalType: parsed.type,
            }));
            break;
          }
          if (parsed.text) {
            // Auto-spawn Claude if not running
            if (!sessionManager.isClaudeRunning(clientSessionId)) {
              const claude = sessionManager.spawnClaudeProcess(clientSessionId);
              if (claude) {
                ws.send(JSON.stringify({
                  type: 'claude:spawned',
                  sessionId: clientSessionId,
                  message: 'Claude process started',
                }));
                // Wait a moment for Claude to initialize before sending message
                setTimeout(() => {
                  sessionManager.sendMessageToClaude(clientSessionId, parsed.text);
                }, 500);
              } else {
                ws.send(JSON.stringify({
                  type: 'error',
                  message: 'Failed to spawn Claude',
                  originalType: parsed.type,
                }));
              }
            } else {
              sessionManager.sendMessageToClaude(clientSessionId, parsed.text);
            }
          }
          break;
        }

        case 'claude:spawn': {
          if (!clientSessionId) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'No active session',
              originalType: parsed.type,
            }));
            break;
          }
          if (!sessionManager.isClaudeRunning(clientSessionId)) {
            const claude = sessionManager.spawnClaudeProcess(clientSessionId);
            if (claude) {
              ws.send(JSON.stringify({
                type: 'claude:spawned',
                sessionId: clientSessionId,
                message: 'Claude process started',
              }));
            } else {
              ws.send(JSON.stringify({
                type: 'error',
                message: 'Failed to spawn Claude',
                originalType: parsed.type,
              }));
            }
          } else {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Claude process already running for this session',
              originalType: parsed.type,
            }));
          }
          break;
        }

        case 'claude:kill': {
          if (clientSessionId && sessionManager.isClaudeRunning(clientSessionId)) {
            sessionManager.killClaudeProcess(clientSessionId);
            ws.send(JSON.stringify({
              type: 'claude:killed',
              sessionId: clientSessionId,
              message: 'Claude process stopped',
            }));
          }
          break;
        }

        case 'claude:resize':
          // Resize not supported in stream-json mode
          break;

        // File handlers
        case 'files:list':
          try {
            const clientFileOps = getClientFileOps(ws);
            const listPath = parsed.path || '.';
            console.log(`[files:list] Listing: ${listPath}`);
            const entries = await clientFileOps.listDirectory(listPath);
            console.log(`[files:list] Found ${entries.length} entries in ${listPath}`);
            ws.send(JSON.stringify({
              type: 'files:tree',
              path: listPath,
              entries,
            }));
          } catch (error) {
            console.error(`[files:list] Error:`, error);
            ws.send(JSON.stringify({
              type: 'error',
              message: error instanceof Error ? error.message : 'Failed to list directory',
              originalType: parsed.type,
            }));
          }
          break;

        case 'file:read':
          try {
            const clientFileOps = getClientFileOps(ws);
            console.log(`[file:read] Reading: ${parsed.path}`);
            const content = await clientFileOps.readFile(parsed.path);
            console.log(`[file:read] Success: ${parsed.path} (${content.length} bytes)`);
            ws.send(JSON.stringify({
              type: 'file:content',
              path: parsed.path,
              content,
            }));
          } catch (error) {
            console.error(`[file:read] Error: ${parsed.path}`, error);
            ws.send(JSON.stringify({
              type: 'error',
              message: error instanceof Error ? error.message : 'Failed to read file',
              originalType: parsed.type,
            }));
          }
          break;

        case 'file:save':
          try {
            console.log(`[file:save] Saving: ${parsed.path}`);
            const clientFileOps = getClientFileOps(ws);
            // Record write to prevent watcher self-loop
            fileWatcher.recordWrite(parsed.path);
            await clientFileOps.writeFile(parsed.path, parsed.content);
            console.log(`[file:save] Success: ${parsed.path}`);
            ws.send(JSON.stringify({
              type: 'file:saved',
              path: parsed.path,
            }));
          } catch (error) {
            console.error(`[file:save] Error: ${parsed.path}`, error);
            ws.send(JSON.stringify({
              type: 'error',
              message: error instanceof Error ? error.message : 'Failed to save file',
              originalType: parsed.type,
            }));
          }
          break;

        // Set working directory for explorer/git
        case 'explorer:setcwd':
          if (parsed.path) {
            clientCwdMap.set(ws, parsed.path);
            console.log(`Client CWD set to: ${parsed.path}`);
            ws.send(JSON.stringify({
              type: 'explorer:cwd',
              path: parsed.path,
            }));
          }
          break;

        // Git handlers
        case 'git:status':
          try {
            const clientGitOps = getClientGitOps(ws);
            const status = await clientGitOps.getStatus();
            ws.send(JSON.stringify({
              type: 'git:status',
              status,
              cwd: getClientCwd(ws),
            }));
          } catch (error) {
            ws.send(JSON.stringify({
              type: 'error',
              message: error instanceof Error ? error.message : 'Failed to get git status',
              originalType: parsed.type,
            }));
          }
          break;

        case 'git:stage':
          try {
            const clientGitOps = getClientGitOps(ws);
            const paths = Array.isArray(parsed.paths) ? parsed.paths : [parsed.path];
            await clientGitOps.stage(paths);
            const statusAfterStage = await clientGitOps.getStatus();
            ws.send(JSON.stringify({
              type: 'git:staged',
              paths,
              status: statusAfterStage,
            }));
          } catch (error) {
            ws.send(JSON.stringify({
              type: 'error',
              message: error instanceof Error ? error.message : 'Failed to stage files',
              originalType: parsed.type,
            }));
          }
          break;

        case 'git:unstage':
          try {
            const clientGitOps = getClientGitOps(ws);
            const paths = Array.isArray(parsed.paths) ? parsed.paths : [parsed.path];
            await clientGitOps.unstage(paths);
            const statusAfterUnstage = await clientGitOps.getStatus();
            ws.send(JSON.stringify({
              type: 'git:unstaged',
              paths,
              status: statusAfterUnstage,
            }));
          } catch (error) {
            ws.send(JSON.stringify({
              type: 'error',
              message: error instanceof Error ? error.message : 'Failed to unstage files',
              originalType: parsed.type,
            }));
          }
          break;

        case 'git:commit':
          try {
            const clientGitOps = getClientGitOps(ws);
            if (!parsed.message || !parsed.message.trim()) {
              throw new Error('Commit message is required');
            }
            const commitHash = await clientGitOps.commit(parsed.message);
            const statusAfterCommit = await clientGitOps.getStatus();
            ws.send(JSON.stringify({
              type: 'git:committed',
              hash: commitHash,
              message: parsed.message,
              status: statusAfterCommit,
            }));
          } catch (error) {
            ws.send(JSON.stringify({
              type: 'error',
              message: error instanceof Error ? error.message : 'Failed to commit',
              originalType: parsed.type,
            }));
          }
          break;

        case 'git:push':
          try {
            const clientGitOps = getClientGitOps(ws);
            await clientGitOps.push(parsed.remote || 'origin', parsed.branch);
            const statusAfterPush = await clientGitOps.getStatus();
            ws.send(JSON.stringify({
              type: 'git:pushed',
              status: statusAfterPush,
            }));
          } catch (error) {
            ws.send(JSON.stringify({
              type: 'error',
              message: error instanceof Error ? error.message : 'Failed to push',
              originalType: parsed.type,
            }));
          }
          break;

        case 'git:pull':
          try {
            const clientGitOps = getClientGitOps(ws);
            await clientGitOps.pull(parsed.remote || 'origin', parsed.branch);
            const statusAfterPull = await clientGitOps.getStatus();
            ws.send(JSON.stringify({
              type: 'git:pulled',
              status: statusAfterPull,
            }));
          } catch (error) {
            ws.send(JSON.stringify({
              type: 'error',
              message: error instanceof Error ? error.message : 'Failed to pull',
              originalType: parsed.type,
            }));
          }
          break;

        case 'git:linediff':
          try {
            const clientGitOps = getClientGitOps(ws);
            const lineDiff = await clientGitOps.getLineDiff(parsed.path);
            ws.send(JSON.stringify({
              type: 'git:linediff',
              path: parsed.path,
              ...lineDiff,
            }));
          } catch (error) {
            ws.send(JSON.stringify({
              type: 'error',
              message: error instanceof Error ? error.message : 'Failed to get line diff',
              originalType: parsed.type,
            }));
          }
          break;

        // PTY terminal handlers
        case 'pty:spawn': {
          const cols = parsed.cols || 80;
          const rows = parsed.rows || 24;
          // Use persisted lastTerminalCwd, then projectRoot, then passed cwd
          const session = clientSessionId ? sessionManager.getSession(clientSessionId) : null;
          const cwd = parsed.cwd || session?.lastTerminalCwd || session?.projectRoot;
          const id = ptyManager.spawn(cols, rows, cwd);

          // Track this PTY for this client
          if (!clientPtyMap.has(ws)) {
            clientPtyMap.set(ws, new Set());
          }
          clientPtyMap.get(ws)!.add(id);

          // Track which session this PTY belongs to (for cwd persistence)
          if (clientSessionId) {
            ptySessionMap.set(id, clientSessionId);
          }

          ws.send(JSON.stringify({
            type: 'pty:spawned',
            id,
            cwd,  // Send initial cwd to client
          }));
          break;
        }

        case 'pty:input':
          if (parsed.id && parsed.data) {
            const success = ptyManager.write(parsed.id, parsed.data);
            if (!success) {
              ws.send(JSON.stringify({
                type: 'error',
                message: `Terminal ${parsed.id} not found`,
                originalType: parsed.type,
              }));
            }
          }
          break;

        case 'pty:resize':
          if (parsed.id && parsed.cols && parsed.rows) {
            ptyManager.resize(parsed.id, parsed.cols, parsed.rows);
          }
          break;

        case 'pty:kill':
          if (parsed.id) {
            const success = ptyManager.kill(parsed.id);
            if (success) {
              const ptyIds = clientPtyMap.get(ws);
              ptyIds?.delete(parsed.id);
              ws.send(JSON.stringify({
                type: 'pty:killed',
                id: parsed.id,
              }));
            }
          }
          break;

        // Explorer path persistence
        case 'explorer:path':
          if (clientSessionId && parsed.path) {
            sessionManager.updateExplorerPath(clientSessionId, parsed.path);
          }
          break;

        // Editor tabs persistence
        case 'editor:tabs':
          if (clientSessionId && Array.isArray(parsed.tabs)) {
            sessionManager.updateEditorTabs(
              clientSessionId,
              parsed.tabs,
              typeof parsed.activeIndex === 'number' ? parsed.activeIndex : -1
            );
          }
          break;

        // Editor draft persistence (dirty content)
        case 'editor:draft':
          if (clientSessionId && parsed.path && typeof parsed.content === 'string') {
            sessionManager.updateEditorDraft(clientSessionId, parsed.path, parsed.content);
          }
          break;

        // Clear draft when file saved
        case 'editor:draft:clear':
          if (clientSessionId && parsed.path) {
            sessionManager.clearEditorDraft(clientSessionId, parsed.path);
          }
          break;

        // Claude CLI status check/refresh
        case 'claude:cli:status':
          ws.send(JSON.stringify({
            type: 'claude:cli:status',
            ...getCachedClaudeCliStatus(),
          }));
          break;

        case 'claude:cli:refresh':
          const newStatus = refreshClaudeCliStatus();
          ws.send(JSON.stringify({
            type: 'claude:cli:status',
            ...newStatus,
          }));
          break;

        default:
          ws.send(JSON.stringify({
            type: 'error',
            message: `Unknown message type: ${parsed.type}`,
            originalType: parsed.type,
          }));
      }
    } catch {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid JSON',
      }));
    }
  };

  // Get active session or create default one
  let activeSession = sessionManager.getActiveSession();
  if (!activeSession) {
    // Create default session for PROJECT_ROOT
    activeSession = sessionManager.createSession('Default', PROJECT_ROOT);
    await sessionManager.switchSession(activeSession.id);
  }

  // Associate client with active session
  clientSessionMap.set(ws, activeSession.id);

  // Get session with history
  const sessionWithHistory = await sessionManager.getActiveSessionWithHistory();
  const isClaudeRunning = sessionManager.isClaudeRunning(activeSession.id);

  // Get Claude CLI status
  const cliStatus = getCachedClaudeCliStatus();

  // Send connection confirmation with session info and CLI status
  ws.send(JSON.stringify({
    type: 'connected',
    session: sessionWithHistory,
    claudeRunning: isClaudeRunning,
    sessions: sessionManager.listSessions(),
    cliStatus,
  }));

  // Mark setup as complete and process any queued messages
  setupComplete = true;
  for (const msg of pendingMessages) {
    await handleMessage(msg);
  }

  ws.on('close', () => {
    console.log('Client disconnected');
    // Kill all PTYs owned by this client
    const ptyIds = clientPtyMap.get(ws);
    if (ptyIds) {
      for (const id of ptyIds) {
        ptyManager.kill(id);
      }
      clientPtyMap.delete(ws);
    }
    // Remove client session association
    clientSessionMap.delete(ws);
    // Remove client cwd
    clientCwdMap.delete(ws);
  });
});

// Start server
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`WebSocket available on ws://0.0.0.0:${PORT}/ws`);
  console.log(`Project root: ${PROJECT_ROOT}`);

  // Check Claude CLI status at startup
  const cliStatus = getCachedClaudeCliStatus();
  if (cliStatus.installed && cliStatus.authenticated) {
    console.log(`Claude CLI: v${cliStatus.version || 'unknown'} (authenticated)`);
  } else if (cliStatus.installed && !cliStatus.authenticated) {
    console.warn('Claude CLI: installed but NOT authenticated');
    console.warn('Run "claude" in a terminal to authenticate');
  } else {
    console.warn('Claude CLI: NOT INSTALLED');
    console.warn('Install with: npm install -g @anthropic-ai/claude-code');
  }

  // Create default session if none exist and auto-spawn Claude
  let activeSession = sessionManager.getActiveSession();
  if (!activeSession) {
    activeSession = sessionManager.createSession('Default', PROJECT_ROOT);
    await sessionManager.switchSession(activeSession.id);
  }

  // Auto-spawn Claude for active session (only if CLI is ready)
  if (cliStatus.installed && cliStatus.authenticated) {
    try {
      if (!sessionManager.isClaudeRunning(activeSession.id)) {
        sessionManager.spawnClaudeProcess(activeSession.id);
        console.log('Claude process started for default session');
      }
    } catch (error) {
      console.error('Failed to spawn Claude:', error);
    }
  }

  // Start file watcher
  fileWatcher.start();
});

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down...');
  await stopFileWatcher();
  shutdownPtyManager();
  shutdownSessionManager();
  wss.close();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
