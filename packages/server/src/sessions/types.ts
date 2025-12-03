// Session data types

export type SessionStatus = 'running' | 'stopped' | 'error';

export interface OutputEntry {
  timestamp: string;  // ISO string for JSON serialization
  type: 'user' | 'claude' | 'system';
  content: string;
}

export interface EditorTab {
  path: string;
  // Note: content is NOT persisted - will be loaded fresh on restore
}

export interface EditorDraft {
  path: string;
  content: string;
  savedAt: string;  // ISO string - when draft was last updated
}

export interface Session {
  id: string;
  name: string;
  projectRoot: string;
  createdAt: string;    // ISO string
  lastActiveAt: string; // ISO string
  status: SessionStatus;
  // Persisted UI state
  lastTerminalCwd?: string;   // Terminal's last known directory
  lastExplorerPath?: string;  // Explorer's last viewed directory
  lastClaudeCwd?: string;     // Claude's last known cwd from messages
  openEditorTabs?: EditorTab[];  // Open editor tabs (paths only)
  activeEditorTab?: number;      // Index of active tab
  editorDrafts?: EditorDraft[];  // Unsaved content for dirty tabs
}

export interface SessionWithHistory extends Session {
  history: OutputEntry[];
}

// Serialized format for sessions.json
export interface SessionsFile {
  version: number;
  activeSessionId: string | null;
  sessions: Session[];
}

// Runtime session with Claude process reference
export interface RuntimeSession {
  session: Session;
  claudeProcessId: string | null;
}
