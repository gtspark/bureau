import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { ClaudeProcess } from '../claude/process.js';
import { Session, SessionsFile, SessionWithHistory, OutputEntry } from './types.js';
import { HistoryManager, getBureauDir } from './history.js';

const SESSIONS_FILE = 'sessions.json';

export class SessionManager extends EventEmitter {
  private sessions: Map<string, Session> = new Map();
  private claudeProcesses: Map<string, ClaudeProcess> = new Map();
  private historyManagers: Map<string, HistoryManager> = new Map();
  private activeSessionId: string | null = null;
  private sessionsFilePath: string;

  constructor() {
    super();
    this.sessionsFilePath = path.join(getBureauDir(), SESSIONS_FILE);
    this.loadFromDisk();
  }

  // Load sessions from disk
  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.sessionsFilePath)) {
        const content = fs.readFileSync(this.sessionsFilePath, 'utf-8');
        const data: SessionsFile = JSON.parse(content);

        for (const session of data.sessions) {
          this.sessions.set(session.id, session);
          this.historyManagers.set(session.id, new HistoryManager(session.id));
        }

        this.activeSessionId = data.activeSessionId;
        console.log(`Loaded ${this.sessions.size} sessions from disk`);
      }
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  }

  // Save sessions to disk
  private saveToDisk(): void {
    try {
      const data: SessionsFile = {
        version: 1,
        activeSessionId: this.activeSessionId,
        sessions: Array.from(this.sessions.values()),
      };
      fs.writeFileSync(this.sessionsFilePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to save sessions:', error);
    }
  }

  // Create a new session
  createSession(name: string, projectRoot: string): Session {
    const id = randomUUID();
    const now = new Date().toISOString();

    const session: Session = {
      id,
      name: name || path.basename(projectRoot),
      projectRoot,
      createdAt: now,
      lastActiveAt: now,
      status: 'stopped',
    };

    this.sessions.set(id, session);
    this.historyManagers.set(id, new HistoryManager(id));
    this.saveToDisk();

    console.log(`Created session: ${session.name} (${id})`);
    this.emit('session:created', session);
    return session;
  }

  // Get a session by ID
  getSession(id: string): Session | null {
    return this.sessions.get(id) || null;
  }

  // List all sessions
  listSessions(): Session[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
    );
  }

  // Get active session
  getActiveSession(): Session | null {
    if (!this.activeSessionId) return null;
    return this.sessions.get(this.activeSessionId) || null;
  }

  // Get active session with history
  async getActiveSessionWithHistory(historyLimit: number = 500): Promise<SessionWithHistory | null> {
    const session = this.getActiveSession();
    if (!session) return null;

    const historyManager = this.historyManagers.get(session.id);
    const history = historyManager ? await historyManager.load(historyLimit) : [];

    return { ...session, history };
  }

  // Switch to a session
  async switchSession(id: string): Promise<SessionWithHistory | null> {
    const session = this.sessions.get(id);
    if (!session) return null;

    this.activeSessionId = id;
    session.lastActiveAt = new Date().toISOString();
    this.saveToDisk();

    console.log(`Switched to session: ${session.name} (${id})`);
    this.emit('session:switched', session);

    const historyManager = this.historyManagers.get(id);
    const history = historyManager ? await historyManager.load(500) : [];

    return { ...session, history };
  }

  // Rename a session
  renameSession(id: string, name: string): Session | null {
    const session = this.sessions.get(id);
    if (!session) return null;

    session.name = name;
    session.lastActiveAt = new Date().toISOString();
    this.saveToDisk();

    console.log(`Renamed session ${id} to: ${name}`);
    this.emit('session:renamed', session);
    return session;
  }

  // Delete a session
  deleteSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    // Kill Claude process if running
    this.killClaudeProcess(id);

    // Delete history
    HistoryManager.delete(id);
    this.historyManagers.delete(id);

    // Remove session
    this.sessions.delete(id);

    // Update active session if needed
    if (this.activeSessionId === id) {
      const remaining = this.listSessions();
      this.activeSessionId = remaining.length > 0 ? remaining[0].id : null;
    }

    this.saveToDisk();
    console.log(`Deleted session: ${session.name} (${id})`);
    this.emit('session:deleted', { id, name: session.name });
    return true;
  }

  // Spawn Claude for a session
  spawnClaudeProcess(sessionId: string): ClaudeProcess | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Kill existing process if any
    this.killClaudeProcess(sessionId);

    // Pass sessionId for conversation persistence
    const claude = new ClaudeProcess(session.projectRoot, sessionId);

    // Forward events with session context
    claude.on('message', (message: object) => {
      // Record to history
      const historyManager = this.historyManagers.get(sessionId);
      if (historyManager) {
        const entry: OutputEntry = {
          timestamp: new Date().toISOString(),
          type: 'claude',
          content: JSON.stringify(message),
        };
        historyManager.append(entry);
      }

      // Extract and persist cwd from Claude messages
      const msg = message as Record<string, unknown>;
      if (msg.type === 'system' && typeof msg.cwd === 'string') {
        this.updateClaudeCwd(sessionId, msg.cwd);
      } else if (msg.type === 'result' && typeof msg.cwd === 'string') {
        this.updateClaudeCwd(sessionId, msg.cwd);
      }

      this.emit('claude:message', { sessionId, message });
    });

    claude.on('exit', (code: number) => {
      session.status = 'stopped';
      this.saveToDisk();
      this.emit('claude:exit', { sessionId, code });
    });

    claude.on('error', (error: Error) => {
      session.status = 'error';
      this.saveToDisk();
      this.emit('claude:error', { sessionId, message: error.message });
    });

    claude.on('compacted', (data: { trigger: string; preTokens: number }) => {
      console.log(`Context compaction in session ${sessionId}:`, data);
      this.emit('claude:compacted', { sessionId, ...data });
    });

    try {
      claude.spawn();
      this.claudeProcesses.set(sessionId, claude);
      session.status = 'running';
      session.lastActiveAt = new Date().toISOString();
      this.saveToDisk();
      console.log(`Spawned Claude for session: ${session.name}`);
      return claude;
    } catch (error) {
      session.status = 'error';
      this.saveToDisk();
      console.error(`Failed to spawn Claude for session ${sessionId}:`, error);
      return null;
    }
  }

  // Kill Claude for a session
  killClaudeProcess(sessionId: string): void {
    const claude = this.claudeProcesses.get(sessionId);
    if (claude) {
      claude.kill();
      this.claudeProcesses.delete(sessionId);

      const session = this.sessions.get(sessionId);
      if (session) {
        session.status = 'stopped';
        this.saveToDisk();
      }
    }
  }

  // Get Claude process for a session
  getClaudeProcess(sessionId: string): ClaudeProcess | null {
    return this.claudeProcesses.get(sessionId) || null;
  }

  // Check if session has running Claude
  isClaudeRunning(sessionId: string): boolean {
    const claude = this.claudeProcesses.get(sessionId);
    return claude?.isRunning || false;
  }

  // Send message to Claude in a session
  sendMessageToClaude(sessionId: string, text: string): boolean {
    const claude = this.claudeProcesses.get(sessionId);
    if (!claude?.isRunning) return false;

    // Record user message to history
    const historyManager = this.historyManagers.get(sessionId);
    if (historyManager) {
      const entry: OutputEntry = {
        timestamp: new Date().toISOString(),
        type: 'user',
        content: text,
      };
      historyManager.append(entry);
    }

    claude.sendMessage(text);

    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActiveAt = new Date().toISOString();
      this.saveToDisk();
    }

    return true;
  }

  // Add system message to history
  addSystemMessage(sessionId: string, content: string): void {
    const historyManager = this.historyManagers.get(sessionId);
    if (historyManager) {
      const entry: OutputEntry = {
        timestamp: new Date().toISOString(),
        type: 'system',
        content,
      };
      historyManager.append(entry);
    }
  }

  // Update session's terminal cwd
  updateTerminalCwd(sessionId: string, cwd: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.lastTerminalCwd !== cwd) {
      session.lastTerminalCwd = cwd;
      this.saveToDisk();
    }
  }

  // Update session's explorer path
  updateExplorerPath(sessionId: string, path: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.lastExplorerPath !== path) {
      session.lastExplorerPath = path;
      this.saveToDisk();
    }
  }

  // Update session's Claude cwd
  updateClaudeCwd(sessionId: string, cwd: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.lastClaudeCwd !== cwd) {
      session.lastClaudeCwd = cwd;
      this.saveToDisk();
    }
  }

  // Update session's open editor tabs
  updateEditorTabs(sessionId: string, tabs: Array<{ path: string }>, activeIndex: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.openEditorTabs = tabs;
      session.activeEditorTab = activeIndex;
      this.saveToDisk();
    }
  }

  // Update or add a draft for a file
  updateEditorDraft(sessionId: string, path: string, content: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (!session.editorDrafts) {
      session.editorDrafts = [];
    }

    const existingIndex = session.editorDrafts.findIndex(d => d.path === path);
    const draft = {
      path,
      content,
      savedAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      session.editorDrafts[existingIndex] = draft;
    } else {
      session.editorDrafts.push(draft);
    }

    this.saveToDisk();
  }

  // Clear a draft when file is saved or closed
  clearEditorDraft(sessionId: string, path: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.editorDrafts) return;

    session.editorDrafts = session.editorDrafts.filter(d => d.path !== path);
    this.saveToDisk();
  }

  // Get all drafts for a session
  getEditorDrafts(sessionId: string): Array<{ path: string; content: string; savedAt: string }> {
    const session = this.sessions.get(sessionId);
    return session?.editorDrafts || [];
  }

  // Restore running sessions on startup
  async restoreRunningSessions(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.status === 'running') {
        console.log(`Restoring session: ${session.name}`);
        this.spawnClaudeProcess(session.id);
      }
    }
  }

  // Shutdown all sessions
  shutdown(): void {
    console.log('Shutting down all sessions...');
    for (const sessionId of this.claudeProcesses.keys()) {
      this.killClaudeProcess(sessionId);
    }
  }
}

// Singleton
let sessionManager: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!sessionManager) {
    sessionManager = new SessionManager();
  }
  return sessionManager;
}

export function shutdownSessionManager(): void {
  if (sessionManager) {
    sessionManager.shutdown();
    sessionManager = null;
  }
}
