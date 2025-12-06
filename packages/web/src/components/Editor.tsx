import { useEffect, useRef, useState, useCallback } from 'react'
import MonacoEditor, { OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { FileCode, X, AlertTriangle } from 'lucide-react'
import { cn } from '../lib/cn'
import { ConfirmModal } from './ConfirmModal'

const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:3006/ws`

interface OpenFile {
  path: string
  content: string
  isDirty?: boolean
  originalContent?: string  // Clean content from disk (for diff computation)
}

interface LineDiff {
  added: number[]
  modified: number[]
  deleted: number[]
}

// Compute diff using a simple approach that matches git-style output
// Returns: added (new lines), modified (changed lines), deleted (line numbers where deletions occurred)
function computeLineDiff(original: string, current: string): LineDiff {
  if (original === current) {
    return { added: [], modified: [], deleted: [] }
  }

  const originalLines = original.split('\n')
  const currentLines = current.split('\n')

  const added: number[] = []
  const modified: number[] = []
  const deleted: number[] = []

  // Use Myers-like approach: walk through both arrays tracking changes
  const m = originalLines.length
  const n = currentLines.length

  // Build LCS for accurate tracking
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (originalLines[i - 1] === currentLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to build edit script
  const edits: Array<{ type: 'keep' | 'add' | 'del'; origLine?: number; currLine?: number }> = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && originalLines[i - 1] === currentLines[j - 1]) {
      edits.unshift({ type: 'keep', origLine: i, currLine: j })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      edits.unshift({ type: 'add', currLine: j })
      j--
    } else {
      edits.unshift({ type: 'del', origLine: i })
      i--
    }
  }

  // Process edits to identify added, modified, deleted
  // Modified = when a delete is immediately followed by an add (replacement)
  for (let k = 0; k < edits.length; k++) {
    const edit = edits[k]

    if (edit.type === 'add') {
      // Check if previous edit was a delete (this is a modification)
      if (k > 0 && edits[k - 1].type === 'del') {
        modified.push(edit.currLine!)
      } else {
        added.push(edit.currLine!)
      }
    } else if (edit.type === 'del') {
      // Check if next edit is an add (will be marked as modified, so skip delete marker)
      if (k + 1 < edits.length && edits[k + 1].type === 'add') {
        // This delete is part of a modification, don't mark separately
      } else {
        // Pure deletion - mark at the current line position
        // Find the current line position by looking at surrounding context
        const nextKeepOrAdd = edits.slice(k + 1).find(e => e.type === 'keep' || e.type === 'add')
        if (nextKeepOrAdd?.currLine) {
          deleted.push(nextKeepOrAdd.currLine)
        } else if (n > 0) {
          deleted.push(n) // deletion at end of file
        }
      }
    }
  }

  return { added, modified, deleted }
}

interface EditorProps {
  files: OpenFile[]
  activeIndex: number
  onTabClick?: (index: number) => void
  onContentChange?: (path: string, content: string) => void
  onClose?: (index: number) => void
  onFileDrop?: (path: string) => void
  onSave?: (path: string) => void
}

// Detect language from file extension
function getLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    sql: 'sql',
    graphql: 'graphql',
    dockerfile: 'dockerfile',
  }
  return languageMap[ext || ''] || 'plaintext'
}

export function Editor({ files, activeIndex, onTabClick, onContentChange, onClose, onFileDrop, onSave }: EditorProps) {
  const [isSaving, setIsSaving] = useState(false)
  const [externalChange, setExternalChange] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [closeConfirm, setCloseConfirm] = useState<{ index: number; filename: string } | null>(null)
  const [lineDiff, setLineDiff] = useState<LineDiff | null>(null)

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const currentPathRef = useRef<string | null>(null)
  const originalContentRef = useRef<string>('')
  const decorationsRef = useRef<string[]>([])

  // Get active file
  const activeFile = activeIndex >= 0 && activeIndex < files.length ? files[activeIndex] : null
  const path = activeFile?.path || null
  const content = activeFile?.content || ''
  const isDirty = activeFile?.isDirty || false

  // Update refs when active file changes
  useEffect(() => {
    currentPathRef.current = path
    // Use originalContent if available (for dirty files restored from session), otherwise current content
    originalContentRef.current = activeFile?.originalContent ?? content
    setExternalChange(null)
    setLineDiff(null)
  }, [path]) // Only reset when path changes, not content

  // Compute local diff when content changes (debounced)
  useEffect(() => {
    if (!path || !content) return

    const timer = setTimeout(() => {
      const diff = computeLineDiff(originalContentRef.current, content)
      setLineDiff(diff)
    }, 150) // Debounce to avoid excessive computation while typing

    return () => clearTimeout(timer)
  }, [path, content])

  // WebSocket connection for saving and external changes
  useEffect(() => {
    let isCleanedUp = false
    let reconnectTimeout: number | null = null

    const connect = () => {
      if (isCleanedUp) return

      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onclose = () => {
        if (isCleanedUp) return
        reconnectTimeout = window.setTimeout(connect, 2000)
      }

      ws.onmessage = (event) => {
        if (isCleanedUp) return

        try {
          const msg = JSON.parse(event.data)

          switch (msg.type) {
            case 'file:saved':
              if (msg.path === currentPathRef.current) {
                setIsSaving(false)
                // After save, the current content becomes the new original
                originalContentRef.current = editorRef.current?.getValue() || ''
                // Recompute diff immediately (will be empty since original=current)
                setLineDiff({ added: [], modified: [], deleted: [] })
                // Notify parent that file was saved (clears isDirty)
                onSave?.(msg.path)
              }
              break

            case 'file:changed':
              // External change detected
              if (msg.path === currentPathRef.current && msg.content) {
                const currentContent = editorRef.current?.getValue() || ''
                if (currentContent !== msg.content) {
                  if (isDirty) {
                    // File is dirty - show warning
                    setExternalChange(msg.content)
                  } else {
                    // Not dirty - update silently
                    editorRef.current?.setValue(msg.content)
                    originalContentRef.current = msg.content
                    if (onContentChange && currentPathRef.current) {
                      onContentChange(currentPathRef.current, msg.content)
                    }
                  }
                }
              }
              break

            case 'error':
              if (msg.originalType === 'file:save') {
                setIsSaving(false)
                alert(`Failed to save: ${msg.message}`)
              }
              break
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    connect()

    return () => {
      isCleanedUp = true
      if (reconnectTimeout) clearTimeout(reconnectTimeout)
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
      }
    }
  }, [isDirty, onContentChange])

  // Apply diff decorations
  useEffect(() => {
    if (!editorRef.current || !monacoRef.current || !lineDiff) return

    const monaco = monacoRef.current
    const editor = editorRef.current

    const decorations: editor.IModelDeltaDecoration[] = []

    // Added lines - green gutter bar
    for (const line of lineDiff.added) {
      decorations.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: 'diff-gutter-added',
          overviewRuler: {
            color: '#22c55e',
            position: monaco.editor.OverviewRulerLane.Left,
          },
        },
      })
    }

    // Modified lines - blue gutter bar
    for (const line of lineDiff.modified) {
      decorations.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: 'diff-gutter-modified',
          overviewRuler: {
            color: '#3b82f6',
            position: monaco.editor.OverviewRulerLane.Left,
          },
        },
      })
    }

    // Deleted lines - red triangle marker
    for (const line of lineDiff.deleted) {
      decorations.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: false,
          linesDecorationsClassName: 'diff-gutter-deleted',
          overviewRuler: {
            color: '#ef4444',
            position: monaco.editor.OverviewRulerLane.Left,
          },
        },
      })
    }

    // Apply decorations
    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, decorations)
  }, [lineDiff])

  // Save file - use ref to avoid stale closure in Monaco command
  const saveFileRef = useRef<() => void>(() => {})

  const saveFile = useCallback(() => {
    if (!path || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    if (!isDirty) return

    const currentContent = editorRef.current?.getValue() || ''
    setIsSaving(true)

    wsRef.current.send(JSON.stringify({
      type: 'file:save',
      path,
      content: currentContent,
    }))
  }, [path, isDirty])

  // Keep ref in sync
  useEffect(() => {
    saveFileRef.current = saveFile
  }, [saveFile])

  // Handle editor mount
  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco

    // Disable TypeScript/JavaScript diagnostics (red squiggles)
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    })
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    })

    // Define custom dark theme matching app colors
    monaco.editor.defineTheme('bureau-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0c0c0e',
        'editor.lineHighlightBackground': '#1a1a1f',
        'editorLineNumber.foreground': '#4a4a55',
        'editorLineNumber.activeForeground': '#8a8a95',
        'editor.selectionBackground': '#3b82f620',
        'editor.inactiveSelectionBackground': '#3b82f610',
        'editorCursor.foreground': '#3b82f6',
        'editorWhitespace.foreground': '#2a2a35',
        'editorIndentGuide.background': '#1f1f25',
        'editorIndentGuide.activeBackground': '#3a3a45',
        'scrollbarSlider.background': '#3a3a4580',
        'scrollbarSlider.hoverBackground': '#4a4a5580',
        'scrollbarSlider.activeBackground': '#5a5a6580',
        'minimap.background': '#0a0a0c',
      }
    })
    monaco.editor.setTheme('bureau-dark')

    // Set up keyboard shortcut for save (Cmd/Ctrl+S)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveFileRef.current()
    })
  }

  // Handle content change
  const handleChange = (value: string | undefined) => {
    if (value !== undefined && onContentChange && path) {
      onContentChange(path, value)
    }
  }

  // Accept external change
  const acceptExternalChange = () => {
    if (externalChange !== null && editorRef.current) {
      editorRef.current.setValue(externalChange)
      originalContentRef.current = externalChange
      setExternalChange(null)
      if (onContentChange && path) {
        onContentChange(path, externalChange)
      }
    }
  }

  // Keep local changes
  const keepLocalChanges = () => {
    setExternalChange(null)
  }

  // Handle close with unsaved changes check
  const handleClose = useCallback((index: number) => {
    const file = files[index]
    if (file?.isDirty) {
      const filename = file.path.split('/').pop() || file.path
      setCloseConfirm({ index, filename })
      return
    }
    onClose?.(index)
  }, [files, onClose])

  // Confirm close dirty file
  const confirmClose = useCallback(() => {
    if (closeConfirm) {
      onClose?.(closeConfirm.index)
      setCloseConfirm(null)
    }
  }, [closeConfirm, onClose])

  // Cancel close
  const cancelClose = useCallback(() => {
    setCloseConfirm(null)
  }, [])

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Check if dragging a file from file tree (has text/plain with path)
    if (e.dataTransfer.types.includes('text/plain')) {
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const filePath = e.dataTransfer.getData('text/plain')
    if (filePath && onFileDrop) {
      onFileDrop(filePath)
    }
  }, [onFileDrop])

  if (!path) {
    return (
      <div
        className={cn(
          "h-full w-full flex flex-col items-center justify-center bg-zinc-950/80 text-zinc-500 transition-colors",
          isDragOver && "bg-blue-950/30 border-2 border-dashed border-blue-500/50"
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-zinc-800/50 to-zinc-900/50 flex items-center justify-center mb-4 border border-white/5">
          <FileCode size={32} className={isDragOver ? "text-blue-400" : "text-zinc-600"} />
        </div>
        <p className="text-sm italic">{isDragOver ? 'Drop file to open' : 'Select a file to edit'}</p>
        <p className="text-xs text-zinc-600 mt-2">Or drag a file from the file tree</p>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "h-full flex flex-col overflow-hidden bg-[#0c0c0e] relative",
        isDragOver && "ring-2 ring-inset ring-blue-500/50"
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Close confirmation modal */}
      {closeConfirm && (
        <ConfirmModal
          title="Unsaved Changes"
          message={
            <>
              <span className="text-blue-400 font-medium">{closeConfirm.filename}</span> has unsaved changes. Close anyway?
            </>
          }
          confirmLabel="Close without saving"
          onConfirm={confirmClose}
          onCancel={cancelClose}
        />
      )}

      {/* Drop overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-blue-950/20 z-50 flex items-center justify-center pointer-events-none">
          <div className="bg-zinc-900/90 px-6 py-4 rounded-xl border border-blue-500/50 shadow-lg">
            <p className="text-blue-300 text-sm font-medium">Drop to open in new tab</p>
          </div>
        </div>
      )}
      {/* Tab bar */}
      <div className="bg-[#121214] border-b border-white/5 flex items-center select-none overflow-x-auto pt-1">
        <div className="flex items-center">
          {files.map((file, index) => {
            const filename = file.path.split('/').pop() || file.path
            const isActive = index === activeIndex
            return (
              <div
                key={file.path}
                onClick={() => onTabClick?.(index)}
                onMouseDown={(e) => {
                  // Prevent middle-click from triggering horizontal scroll
                  if (e.button === 1) {
                    e.preventDefault()
                  }
                }}
                onMouseUp={(e) => {
                  // Middle-click to close (use mouseup so preventDefault works)
                  if (e.button === 1) {
                    e.preventDefault()
                    handleClose(index)
                  }
                }}
                className={cn(
                  "group relative flex items-center gap-2 px-3.5 py-2 min-w-[140px] max-w-[220px] cursor-pointer text-xs select-none transition-all duration-200 border-r border-white/5",
                  isActive
                    ? "bg-[#0c0c0e] text-blue-100 rounded-t-lg z-10"
                    : "bg-transparent text-zinc-500 hover:bg-[#18181b] hover:text-zinc-300"
                )}
              >
                {/* Active top highlight */}
                {isActive && (
                  <div className="absolute top-0 left-0 right-0 h-[2px] bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.8)]" />
                )}
                <FileCode size={12} className={isActive ? "text-blue-400" : "opacity-50"} />
                <span className={cn("flex-1 truncate font-medium", isActive ? "text-zinc-100" : "")}>
                  {filename}
                </span>
                {/* Fixed-width container for dirty dot / close button */}
                <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
                  {/* Dirty indicator - hidden on hover */}
                  {file.isDirty && (
                    <div className="w-2 h-2 rounded-full bg-blue-400/80 shadow-[0_0_4px_rgba(96,165,250,0.5)] group-hover:hidden" />
                  )}
                  {/* Close button - shown on hover */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleClose(index)
                    }}
                    className={cn(
                      "hidden group-hover:flex p-0.5 rounded-md hover:bg-white/10 text-zinc-400 hover:text-red-300 transition-colors"
                    )}
                    title="Close file"
                  >
                    <X size={12} />
                  </button>
                </span>
              </div>
            )
          })}
        </div>
        <div className="flex-1" />
        <div className="px-3 text-[10px] text-zinc-500 flex items-center gap-3 flex-shrink-0">
          {isSaving && (
            <span className="text-blue-400 animate-pulse">saving...</span>
          )}
          <span className={cn(
            "px-1.5 py-0.5 rounded",
            isDirty ? "text-blue-400 bg-blue-500/10" : "text-emerald-400 bg-emerald-500/10"
          )}>
            {isDirty ? 'Modified' : 'Saved'}
          </span>
          <span className="text-zinc-600">
            <kbd className="bg-zinc-800 px-1 rounded border border-white/5 font-sans">⌘S</kbd> to save
          </span>
        </div>
      </div>

      {/* External change warning */}
      {externalChange !== null && (
        <div className="bg-yellow-900/30 border-b border-yellow-600/30 px-4 py-2.5 flex items-center gap-3 text-sm backdrop-blur-sm">
          <AlertTriangle size={16} className="text-yellow-400" />
          <span className="text-yellow-200/90 flex-1">
            This file has been changed externally.
          </span>
          <button
            onClick={acceptExternalChange}
            className="bg-yellow-600 hover:bg-yellow-500 px-3 py-1 rounded-lg text-yellow-50 text-xs font-medium transition-colors"
          >
            Load external changes
          </button>
          <button
            onClick={keepLocalChanges}
            className="bg-zinc-700 hover:bg-zinc-600 px-3 py-1 rounded-lg text-zinc-200 text-xs font-medium transition-colors"
          >
            Keep my changes
          </button>
        </div>
      )}

      {/* Monaco Editor */}
      <div className="flex-1 bg-[#0c0c0e]">
        <MonacoEditor
          key={path}
          height="100%"
          language={getLanguage(path)}
          defaultValue={content}
          theme="vs-dark"
          onMount={handleEditorMount}
          onChange={handleChange}
          options={{
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
            fontLigatures: true,
            minimap: { enabled: true, scale: 0.8 },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            insertSpaces: true,
            wordWrap: 'off',
            lineNumbers: 'on',
            renderWhitespace: 'selection',
            bracketPairColorization: { enabled: true },
            padding: { top: 16, bottom: 16 },
            smoothScrolling: true,
            cursorBlinking: 'smooth',
            cursorSmoothCaretAnimation: 'on',
            // Disable validation squiggles - we don't have full project context
            'semanticHighlighting.enabled': false,
          }}
        />
      </div>

      {/* Breadcrumbs */}
      <div className="h-7 bg-[#0c0c0e] border-t border-white/5 flex items-center px-4 text-xs text-zinc-500 gap-1.5 z-10 shadow-[0_-5px_10px_rgba(0,0,0,0.1)]">
        {path.split('/').map((segment, i, arr) => (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <span className="opacity-40">/</span>}
            <span className={cn(
              i === arr.length - 1
                ? "text-blue-400 font-medium flex items-center gap-1.5"
                : "hover:text-zinc-300 cursor-pointer transition-colors"
            )}>
              {i === arr.length - 1 && <FileCode size={10} />}
              {segment}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}
