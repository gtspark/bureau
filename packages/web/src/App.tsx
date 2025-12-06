import { useState, useCallback, useRef, useEffect } from 'react'
import { WebSocketProvider, useWebSocket, useWebSocketMessages } from './contexts/WebSocketContext'
import { SessionProvider, useSession } from './contexts/SessionContext'
import { ToastProvider, useToast } from './contexts/ToastContext'
import { Layout } from './components/Layout'
import { Chat } from './components/Chat'
import { FileTree } from './components/FileTree'
import { Editor } from './components/Editor'
import { GitStatus } from './components/GitStatus'
import { Terminal, TerminalRef } from './components/Terminal'
import { Sidebar } from './components/Sidebar'
import { SecurityWarningModal } from './components/SecurityWarningModal'

interface OpenFile {
  path: string
  content: string
  isDirty?: boolean
  originalContent?: string  // Clean content from disk (for diff computation)
}

function AppContent() {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activeFileIndex, setActiveFileIndex] = useState<number>(-1)
  const [explorerBasePath, setExplorerBasePath] = useState<string | null>(null)
  const [restoredSessionId, setRestoredSessionId] = useState<string | null>(null)
  const { connected, claudeRunning, claudeCwd, lastExplorerPath, projectRoot, send } = useWebSocket()
  const { activeSession } = useSession()
  const toast = useToast()
  const terminalRef = useRef<TerminalRef>(null)
  const draftTimeoutRef = useRef<Record<string, number>>({})

  // Handle global errors via toast (except git errors which are handled in GitStatus)
  useWebSocketMessages((msg) => {
    if (msg.type === 'error') {
      const originalType = msg.originalType as string | undefined
      // Skip git errors (handled in GitStatus) and file:save errors (handled in Editor)
      if (originalType?.startsWith('git:') || originalType === 'file:save') return
      toast.error(msg.message as string)
    } else if (msg.type === 'claude:error') {
      toast.error(`Claude error: ${msg.message}`)
    }
  }, [toast])

  // Track previous projectRoot to detect session changes
  const prevProjectRootRef = useRef<string | null>(null)

  // Initialize/update explorer path from persisted value or project root
  useEffect(() => {
    if (!projectRoot) return

    // Check if projectRoot changed (session switch)
    const projectRootChanged = prevProjectRootRef.current !== null &&
                                prevProjectRootRef.current !== projectRoot
    prevProjectRootRef.current = projectRoot

    // Reset explorer path on session switch OR initial load
    if (explorerBasePath === null || projectRootChanged) {
      // Only use lastExplorerPath if it's within the new projectRoot
      const isValidPath = lastExplorerPath && (
        lastExplorerPath === projectRoot ||
        lastExplorerPath.startsWith(projectRoot + '/')
      )
      const initialPath = isValidPath ? lastExplorerPath : projectRoot
      setExplorerBasePath(initialPath)
      // Also set server cwd for git operations
      send({ type: 'explorer:setcwd', path: initialPath })
    }
  }, [lastExplorerPath, projectRoot, explorerBasePath, send])

  // Restore editor tabs when session changes
  useEffect(() => {
    if (!activeSession || activeSession.id === restoredSessionId) return

    const tabs = activeSession.openEditorTabs
    const activeTab = activeSession.activeEditorTab

    if (tabs && tabs.length > 0) {
      // Load content for each tab by requesting from server
      tabs.forEach(tab => {
        send({ type: 'file:read', path: tab.path })
      })
      // Set active index (files will be populated as file:content messages arrive)
      if (typeof activeTab === 'number' && activeTab >= 0) {
        setActiveFileIndex(activeTab)
      }
    } else {
      // Clear tabs when switching to a session with no tabs
      setOpenFiles([])
      setActiveFileIndex(-1)
    }

    setRestoredSessionId(activeSession.id)
  }, [activeSession, restoredSessionId, send])

  // Persist editor tabs when they change
  useEffect(() => {
    if (!connected || (openFiles.length === 0 && activeFileIndex === -1)) return

    // Debounce to avoid excessive saves
    const timeout = setTimeout(() => {
      send({
        type: 'editor:tabs',
        tabs: openFiles.map(f => ({ path: f.path })),
        activeIndex: activeFileIndex
      })
    }, 500)

    return () => clearTimeout(timeout)
  }, [openFiles, activeFileIndex, connected, send])

  // Track files we're waiting to open (requested but not yet received)
  const pendingFileOpens = useRef<Set<string>>(new Set())
  // Track tool_use IDs and their file paths - we wait for tool_result before opening
  const pendingToolFiles = useRef<Map<string, string>>(new Map())

  // Listen for Claude's file tool usage and file:content responses
  useWebSocketMessages((msg) => {
    // Handle file:content responses (for auto-opening files)
    if (msg.type === 'file:content') {
      const path = msg.path as string
      const content = msg.content as string

      // Only auto-open if we requested this file
      if (pendingFileOpens.current.has(path)) {
        pendingFileOpens.current.delete(path)

        // Check if file is already open
        const existingIndex = openFiles.findIndex(f => f.path === path)
        if (existingIndex >= 0) {
          // Already open - just switch to it and update content
          setOpenFiles(prev => prev.map((f, i) =>
            i === existingIndex ? { ...f, content, isDirty: false } : f
          ))
          setActiveFileIndex(existingIndex)
        } else {
          // Add new file and make it active
          setOpenFiles(prev => {
            const newFiles = [...prev, { path, content, isDirty: false }]
            setActiveFileIndex(newFiles.length - 1)
            return newFiles
          })
        }
      }
    }

    // Detect Claude's file tool usage
    if (msg.type === 'claude:message') {
      const m = msg.message as Record<string, unknown> | undefined

      // On tool_use, record the tool ID and file path (but don't open yet)
      if (m?.type === 'assistant') {
        const message = m.message as Record<string, unknown> | undefined
        const content = message?.content as Array<Record<string, unknown>> | undefined

        if (content) {
          for (const block of content) {
            if (block.type === 'tool_use') {
              const toolId = block.id as string
              const toolName = block.name as string
              const input = block.input as Record<string, unknown> | undefined

              // Check for file tools - record them for when tool completes
              if (input && ['Read', 'Edit', 'Write'].includes(toolName)) {
                const filePath = input.file_path as string | undefined
                if (filePath && filePath.startsWith('/')) {
                  pendingToolFiles.current.set(toolId, filePath)
                }
              }
            }
          }
        }
      }

      // On tool_result, the tool has completed - now safe to open the file
      if (m?.type === 'user') {
        const message = m.message as Record<string, unknown> | undefined
        const content = message?.content as Array<Record<string, unknown>> | undefined

        if (content) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const toolUseId = block.tool_use_id as string
              const filePath = pendingToolFiles.current.get(toolUseId)

              if (filePath) {
                pendingToolFiles.current.delete(toolUseId)

                // Check if already open or pending
                const isOpen = openFiles.some(f => f.path === filePath)
                const isPending = pendingFileOpens.current.has(filePath)

                if (!isOpen && !isPending) {
                  // Request file content to open it
                  pendingFileOpens.current.add(filePath)
                  send({ type: 'file:read', path: filePath })
                } else if (isOpen) {
                  // Already open - request fresh content to update it
                  pendingFileOpens.current.add(filePath)
                  send({ type: 'file:read', path: filePath })
                }
              }
            }
          }
        }
      }
    }
  }, [openFiles, activeFileIndex, send])

  const handleFileSelect = useCallback((path: string, content: string) => {
    setOpenFiles(prev => {
      // Check if file is already open
      const existingIndex = prev.findIndex(f => f.path === path)
      if (existingIndex >= 0) {
        // File already open - just switch to it
        setActiveFileIndex(existingIndex)
        return prev
      }
      // Check if we have a draft for this file
      const draft = activeSession?.editorDrafts?.find(d => d.path === path)
      const isDirty = !!draft
      const fileContent = draft ? draft.content : content
      // Add new file and make it active
      // Store original (disk) content for diff computation
      const newFiles = [...prev, { path, content: fileContent, isDirty, originalContent: content }]
      setActiveFileIndex(newFiles.length - 1)
      return newFiles
    })
  }, [activeSession])

  const handleContentChange = useCallback((path: string, content: string) => {
    setOpenFiles(prev => prev.map(f =>
      f.path === path ? { ...f, content, isDirty: true } : f
    ))
    // Debounce draft sending to avoid overwhelming server during fast typing
    if (draftTimeoutRef.current[path]) {
      clearTimeout(draftTimeoutRef.current[path])
    }
    draftTimeoutRef.current[path] = window.setTimeout(() => {
      send({ type: 'editor:draft', path, content })
      delete draftTimeoutRef.current[path]
    }, 1000)
  }, [send])

  const handleCloseFile = useCallback((index: number) => {
    setOpenFiles(prev => {
      const closedFile = prev[index]
      // Clear draft for closed file
      if (closedFile) {
        send({ type: 'editor:draft:clear', path: closedFile.path })
      }
      const newFiles = prev.filter((_, i) => i !== index)
      // Adjust active index
      if (newFiles.length === 0) {
        setActiveFileIndex(-1)
      } else if (index <= activeFileIndex) {
        setActiveFileIndex(Math.max(0, activeFileIndex - 1))
      }
      return newFiles
    })
  }, [activeFileIndex, send])

  const handleTabClick = useCallback((index: number) => {
    setActiveFileIndex(index)
  }, [])

  // Handle file save - clear dirty state and draft
  const handleFileSave = useCallback((path: string) => {
    setOpenFiles(prev => prev.map(f =>
      f.path === path ? { ...f, isDirty: false, originalContent: f.content } : f
    ))
    // Clear draft on server
    send({ type: 'editor:draft:clear', path })
  }, [send])

  // Handle file drop - request file content to open it
  const handleFileDrop = useCallback((path: string) => {
    // Check if already open
    const existingIndex = openFiles.findIndex(f => f.path === path)
    if (existingIndex >= 0) {
      setActiveFileIndex(existingIndex)
      return
    }
    // Request file content (will be handled by file:content message)
    send({ type: 'file:read', path })
  }, [openFiles, send])

  // Determine Claude status for Layout
  const claudeStatus = !connected ? 'disconnected' : claudeRunning ? 'running' : 'connected'

  // Sync explorer to Claude's cwd and persist
  const handleExplorerSync = useCallback(() => {
    if (claudeCwd) {
      setExplorerBasePath(claudeCwd)
      // Persist to server
      send({ type: 'explorer:path', path: claudeCwd })
    }
  }, [claudeCwd, send])

  // Change explorer path and persist + set server cwd for git
  const handleExplorerPathChange = useCallback((path: string) => {
    // Validate path is within projectRoot
    if (!projectRoot) return
    if (path !== projectRoot && !path.startsWith(projectRoot + '/')) {
      console.warn('Attempted navigation outside projectRoot:', path)
      return
    }
    setExplorerBasePath(path)
    send({ type: 'explorer:path', path })
    send({ type: 'explorer:setcwd', path })
  }, [send, projectRoot])

  // Refresh file tree - just re-request current path
  const handleRefresh = useCallback(() => {
    if (explorerBasePath) {
      send({ type: 'files:list', path: explorerBasePath })
    }
  }, [explorerBasePath, send])

  // File tree for sidebar (use '.' as default until session loads)
  const fileTree = <FileTree onFileSelect={handleFileSelect} onFolderNavigate={handleExplorerPathChange} basePath={explorerBasePath || '.'} />

  // Git status for sidebar
  const gitStatus = <GitStatus />

  // Sidebar with activity bar
  const sidebar = (
    <Sidebar
      fileTree={fileTree}
      gitStatus={gitStatus}
      claudeCwd={claudeCwd}
      explorerBasePath={explorerBasePath || projectRoot || '.'}
      projectRoot={projectRoot || '.'}
      onExplorerSync={handleExplorerSync}
      onPathChange={handleExplorerPathChange}
      onRefresh={handleRefresh}
    />
  )

  // Editor content
  const editor = (
    <Editor
      files={openFiles}
      activeIndex={activeFileIndex}
      onTabClick={handleTabClick}
      onContentChange={handleContentChange}
      onClose={handleCloseFile}
      onFileDrop={handleFileDrop}
      onSave={handleFileSave}
    />
  )

  // Handler to switch terminal to output tab and optionally scroll to a specific tool
  const handleSwitchToOutput = useCallback((toolId?: string) => {
    if (toolId) {
      terminalRef.current?.scrollToTool(toolId)
    } else {
      terminalRef.current?.switchToOutput()
    }
  }, [])

  // Chat content
  const chat = <Chat onSwitchToOutput={handleSwitchToOutput} />

  // Terminal content
  const terminal = <Terminal ref={terminalRef} />

  return (
    <>
      <SecurityWarningModal />
      <Layout
        sidebar={sidebar}
        editor={editor}
        chat={chat}
        terminal={terminal}
        claudeStatus={claudeStatus}
      />
    </>
  )
}

function App() {
  return (
    <WebSocketProvider>
      <SessionProvider>
        <ToastProvider>
          <AppContent />
        </ToastProvider>
      </SessionProvider>
    </WebSocketProvider>
  )
}

export default App
