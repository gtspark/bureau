// Session types for frontend
export type SessionStatus = 'running' | 'stopped' | 'error'

export interface OutputEntry {
  timestamp: string
  type: 'user' | 'claude' | 'system'
  content: string
}

export interface EditorTab {
  path: string
}

export interface EditorDraft {
  path: string
  content: string
  savedAt: string
}

export interface Session {
  id: string
  name: string
  projectRoot: string
  createdAt: string
  lastActiveAt: string
  status: SessionStatus
  openEditorTabs?: EditorTab[]
  activeEditorTab?: number
  editorDrafts?: EditorDraft[]
}

export interface SessionWithHistory extends Session {
  history: OutputEntry[]
}
