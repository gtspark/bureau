import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import '@xterm/xterm/css/xterm.css'
import { useWebSocket, useWebSocketMessages } from '../contexts/WebSocketContext'
import { Trash2, Maximize2, Minimize2, X, Plus, AlertTriangle, RefreshCw } from 'lucide-react'
import { cn } from '../lib/cn'

type TabId = 'terminal' | 'output' | 'problems'

interface TerminalProps {
  isMaximized?: boolean
  onMaximize?: () => void
  onClose?: () => void
}

interface Problem {
  id: string
  type: 'error' | 'warning'
  message: string
  file?: string
  line?: number
  timestamp: Date
}

const TERMINAL_THEME = {
  background: '#09090b',
  foreground: '#e5e5e5',
  cursor: '#ffffff',
  cursorAccent: '#000000',
  selectionBackground: 'rgba(59, 130, 246, 0.3)',
  black: '#09090b',
  red: '#e55561',
  green: '#8cc265',
  yellow: '#d18f52',
  blue: '#4aa5f0',
  magenta: '#c162de',
  cyan: '#42b3c2',
  white: '#e5e5e5',
  brightBlack: '#7a7a7a',
  brightRed: '#ff6b6b',
  brightGreen: '#98d77c',
  brightYellow: '#e5c07b',
  brightBlue: '#61afef',
  brightMagenta: '#d68fd6',
  brightCyan: '#56c8d8',
  brightWhite: '#ffffff',
}

export interface TerminalRef {
  switchToOutput: () => void
  scrollToTool: (toolId: string) => void
}

export const Terminal = forwardRef<TerminalRef, TerminalProps>(function Terminal({ isMaximized = false, onMaximize, onClose }, ref) {
  const { connected, send, claudeCwd } = useWebSocket()
  const [activeTab, setActiveTab] = useState<TabId>('terminal')

  // Expose methods to parent component
  useImperativeHandle(ref, () => ({
    switchToOutput: () => setActiveTab('output'),
    scrollToTool: (toolId: string) => {
      setActiveTab('output')
      // Scroll to the line where this tool was executed
      const lineNumber = toolLineNumbersRef.current.get(toolId)
      if (lineNumber !== undefined && outputTermRef.current) {
        // Scroll so the line is near the top of the viewport
        outputTermRef.current.scrollToLine(lineNumber)
      }
    }
  }), [])
  const [problems, setProblems] = useState<Problem[]>([])

  // PTY terminal refs
  const ptyContainerRef = useRef<HTMLDivElement>(null)
  const ptyTermRef = useRef<XTerm | null>(null)
  const ptyFitRef = useRef<FitAddon | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const ptyReadyRef = useRef(false)

  // Output terminal refs (Claude's bash output)
  const outputContainerRef = useRef<HTMLDivElement>(null)
  const outputTermRef = useRef<XTerm | null>(null)
  const outputFitRef = useRef<FitAddon | null>(null)
  const outputReadyRef = useRef(false)
  const outputQueueRef = useRef<string[]>([])
  const bashToolIdsRef = useRef<Set<string>>(new Set())
  const toolLineNumbersRef = useRef<Map<string, number>>(new Map())

  // Write to output terminal
  const writeOutput = useCallback((text: string) => {
    if (outputTermRef.current && outputReadyRef.current) {
      outputTermRef.current.write(text)
    } else {
      outputQueueRef.current.push(text)
    }
  }, [])

  const writelnOutput = useCallback((text: string) => {
    writeOutput(text + '\r\n')
  }, [writeOutput])

  // Add problem
  const addProblem = useCallback((type: 'error' | 'warning', message: string, file?: string, line?: number) => {
    setProblems(prev => [...prev, {
      id: Date.now().toString(),
      type,
      message,
      file,
      line,
      timestamp: new Date(),
    }])
  }, [])

  // Initialize PTY terminal
  useEffect(() => {
    if (!ptyContainerRef.current) return

    const term = new XTerm({
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: TERMINAL_THEME,
      rightClickSelectsWord: true,
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    const clipboardAddon = new ClipboardAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(clipboardAddon)
    term.open(ptyContainerRef.current)

    ptyTermRef.current = term
    ptyFitRef.current = fitAddon

    requestAnimationFrame(() => {
      try {
        fitAddon.fit()
      } catch {
        // Ignore
      }
      ptyReadyRef.current = true
    })

    // Handle user input - send to PTY
    term.onData((data) => {
      if (ptyIdRef.current) {
        send({ type: 'pty:input', id: ptyIdRef.current, data })
      }
    })

    // Auto-copy on selection complete (like typical Linux terminal behavior)
    // Use mouseup to detect when selection is finalized
    const termElement = ptyContainerRef.current
    const handleMouseUp = () => {
      const selection = term.getSelection()
      if (selection && selection.length > 0) {
        // Try modern clipboard API first, fall back to execCommand for non-HTTPS
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(selection).catch(() => {})
        } else {
          // Fallback: create temporary textarea and use execCommand
          const textarea = document.createElement('textarea')
          textarea.value = selection
          textarea.style.position = 'fixed'
          textarea.style.opacity = '0'
          document.body.appendChild(textarea)
          textarea.select()
          try {
            document.execCommand('copy')
          } catch {}
          document.body.removeChild(textarea)
        }
      }
    }
    termElement?.addEventListener('mouseup', handleMouseUp)

    // Enable Ctrl+V/Cmd+V to paste
    term.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
        navigator.clipboard.readText().then(text => {
          if (text && ptyIdRef.current) {
            send({ type: 'pty:input', id: ptyIdRef.current, data: text })
          }
        })
        return false
      }
      return true
    })

    return () => {
      ptyReadyRef.current = false
      termElement?.removeEventListener('mouseup', handleMouseUp)
      term.dispose()
      ptyTermRef.current = null
      ptyFitRef.current = null
    }
  }, [send])

  // Initialize Output terminal (read-only)
  useEffect(() => {
    if (!outputContainerRef.current) return

    const term = new XTerm({
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: false,
      cursorStyle: 'bar',
      disableStdin: true,
      theme: TERMINAL_THEME,
      rightClickSelectsWord: true,
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    const clipboardAddon = new ClipboardAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(clipboardAddon)
    term.open(outputContainerRef.current)

    outputTermRef.current = term
    outputFitRef.current = fitAddon

    requestAnimationFrame(() => {
      try {
        fitAddon.fit()
      } catch {
        // Ignore
      }
      outputReadyRef.current = true
      // Flush queue
      if (outputQueueRef.current.length > 0) {
        for (const msg of outputQueueRef.current) {
          term.write(msg)
        }
        outputQueueRef.current = []
      }
    })

    // Auto-copy on selection complete (like typical Linux terminal behavior)
    const outputElement = outputContainerRef.current
    const handleOutputMouseUp = () => {
      const selection = term.getSelection()
      if (selection && selection.length > 0) {
        // Try modern clipboard API first, fall back to execCommand for non-HTTPS
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(selection).catch(() => {})
        } else {
          // Fallback: create temporary textarea and use execCommand
          const textarea = document.createElement('textarea')
          textarea.value = selection
          textarea.style.position = 'fixed'
          textarea.style.opacity = '0'
          document.body.appendChild(textarea)
          textarea.select()
          try {
            document.execCommand('copy')
          } catch {}
          document.body.removeChild(textarea)
        }
      }
    }
    outputElement?.addEventListener('mouseup', handleOutputMouseUp)

    return () => {
      outputReadyRef.current = false
      outputElement?.removeEventListener('mouseup', handleOutputMouseUp)
      term.dispose()
      outputTermRef.current = null
      outputFitRef.current = null
    }
  }, [])

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      if (activeTab === 'terminal' && ptyFitRef.current) {
        try {
          ptyFitRef.current.fit()
          if (ptyIdRef.current && ptyTermRef.current) {
            send({
              type: 'pty:resize',
              id: ptyIdRef.current,
              cols: ptyTermRef.current.cols,
              rows: ptyTermRef.current.rows,
            })
          }
        } catch {
          // Ignore
        }
      } else if (activeTab === 'output' && outputFitRef.current) {
        try {
          outputFitRef.current.fit()
        } catch {
          // Ignore
        }
      }
    }

    const resizeObserver = new ResizeObserver(handleResize)
    if (ptyContainerRef.current) resizeObserver.observe(ptyContainerRef.current)
    if (outputContainerRef.current) resizeObserver.observe(outputContainerRef.current)

    window.addEventListener('resize', handleResize)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [activeTab, send])

  // Spawn PTY when connected, clear when disconnected
  useEffect(() => {
    if (connected && !ptyIdRef.current) {
      // Request PTY spawn
      const cols = ptyTermRef.current?.cols || 80
      const rows = ptyTermRef.current?.rows || 24
      send({ type: 'pty:spawn', cols, rows })
    } else if (!connected) {
      // Clear PTY ID on disconnect so we spawn a new one on reconnect
      ptyIdRef.current = null
    }
  }, [connected, send])

  // Handle WebSocket messages
  useWebSocketMessages((msg) => {
    // PTY messages
    if (msg.type === 'pty:spawned') {
      ptyIdRef.current = msg.id as string
      // Focus terminal
      ptyTermRef.current?.focus()
    }

    if (msg.type === 'pty:data' && msg.id === ptyIdRef.current) {
      ptyTermRef.current?.write(msg.data as string)
    }

    if (msg.type === 'pty:exit' && msg.id === ptyIdRef.current) {
      ptyIdRef.current = null
      ptyTermRef.current?.writeln('\r\n\x1b[90m[Terminal exited]\x1b[0m')
    }

    // Claude output messages (for OUTPUT tab)
    if (msg.type === 'claude:message' && msg.message) {
      const m = msg.message as Record<string, unknown>

      if (m.type === 'assistant') {
        const message = m.message as Record<string, unknown> | undefined
        const content = message?.content as Array<Record<string, unknown>> | undefined
        if (content) {
          for (const block of content) {
            if (block.type === 'tool_use') {
              const toolName = (block.name as string) || 'unknown'
              const toolId = block.id as string

              if (toolName === 'Bash' || toolName === 'bash' || toolName === 'execute_command') {
                const input = block.input as Record<string, unknown> | undefined
                const command = (input?.command as string) || (input?.cmd as string) || ''
                if (command) {
                  // Track line number before writing
                  // cursorY is position in viewport, baseY is scroll offset
                  if (toolId && outputTermRef.current) {
                    const buffer = outputTermRef.current.buffer.active
                    const absoluteLine = buffer.baseY + buffer.cursorY
                    toolLineNumbersRef.current.set(toolId, absoluteLine)
                  }
                  writelnOutput(`\x1b[32m➜\x1b[0m \x1b[34m~/project\x1b[0m \x1b[33m$ ${command}\x1b[0m`)
                  if (toolId) {
                    bashToolIdsRef.current.add(toolId)
                  }
                }
              }
            }
          }
        }
      }

      if (m.type === 'user') {
        const message = m.message as Record<string, unknown> | undefined
        const content = message?.content as Array<Record<string, unknown>> | undefined
        if (content) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const toolId = block.tool_use_id as string
              if (toolId && bashToolIdsRef.current.has(toolId)) {
                bashToolIdsRef.current.delete(toolId)

                let output = ''
                if (typeof block.content === 'string') {
                  output = block.content
                } else if (Array.isArray(block.content)) {
                  output = (block.content as Array<{ type: string; text: string }>)
                    .filter((c) => c.type === 'text')
                    .map((c) => c.text)
                    .join('\n')
                }
                if (output) {
                  const lines = output.split('\n')
                  for (const line of lines) {
                    writelnOutput(line)
                  }
                }
              }
            }
          }
        }
      }

      if (m.type === 'system' && m.subtype === 'error') {
        const errorMsg = (m.error as string) || 'Unknown error'
        writelnOutput(`\x1b[31mError: ${errorMsg}\x1b[0m`)
        addProblem('error', errorMsg)
      }
    }

    if (msg.type === 'claude:error') {
      const errorMsg = msg.message as string
      writelnOutput(`\x1b[31mError: ${errorMsg}\x1b[0m`)
      addProblem('error', errorMsg)
    }
  }, [writelnOutput, addProblem])

  // Clear terminals
  const clearTerminal = useCallback(() => {
    if (activeTab === 'terminal') {
      ptyTermRef.current?.clear()
    } else if (activeTab === 'output') {
      outputTermRef.current?.clear()
    } else if (activeTab === 'problems') {
      setProblems([])
    }
  }, [activeTab])

  // Spawn new terminal
  const spawnNewTerminal = useCallback(() => {
    if (ptyIdRef.current) {
      send({ type: 'pty:kill', id: ptyIdRef.current })
      ptyIdRef.current = null
    }
    const cols = ptyTermRef.current?.cols || 80
    const rows = ptyTermRef.current?.rows || 24
    send({ type: 'pty:spawn', cols, rows })
    setActiveTab('terminal')
  }, [send])

  // Sync terminal to Claude's cwd
  const syncWithClaude = useCallback(() => {
    if (ptyIdRef.current && claudeCwd) {
      // Send cd command to PTY
      send({ type: 'pty:input', id: ptyIdRef.current, data: `cd "${claudeCwd}"\r` })
      setActiveTab('terminal')
      ptyTermRef.current?.focus()
    }
  }, [send, claudeCwd])

  const errorCount = problems.filter(p => p.type === 'error').length
  const warningCount = problems.filter(p => p.type === 'warning').length

  return (
    <div className="h-full flex flex-col bg-[#0c0c0e]">
      {/* Terminal Tabs/Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5 bg-[#121214] select-none">
        <div className="flex items-center gap-6 text-[11px] font-medium tracking-wide">
          <button
            onClick={() => setActiveTab('terminal')}
            className={cn(
              "flex items-center gap-1.5 relative group",
              activeTab === 'terminal' ? "text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
            )}
          >
            <span className={activeTab === 'terminal' ? "font-semibold text-blue-400" : ""}>TERMINAL</span>
            {activeTab === 'terminal' && (
              <div className="absolute -bottom-[7px] left-0 right-0 h-[2px] bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.8)] rounded-t-full" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('output')}
            className={cn(
              "flex items-center gap-1.5 relative",
              activeTab === 'output' ? "text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
            )}
          >
            <span className={activeTab === 'output' ? "font-semibold text-blue-400" : ""}>OUTPUT</span>
            {activeTab === 'output' && (
              <div className="absolute -bottom-[7px] left-0 right-0 h-[2px] bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.8)] rounded-t-full" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('problems')}
            className={cn(
              "flex items-center gap-1.5 relative",
              activeTab === 'problems' ? "text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
            )}
          >
            <span className={activeTab === 'problems' ? "font-semibold text-blue-400" : ""}>PROBLEMS</span>
            {(errorCount > 0 || warningCount > 0) && (
              <span className={cn(
                "text-[9px] px-1.5 py-0.5 rounded-full",
                errorCount > 0 ? "bg-red-500/20 text-red-400" : "bg-yellow-500/20 text-yellow-400"
              )}>
                {errorCount + warningCount}
              </span>
            )}
            {activeTab === 'problems' && (
              <div className="absolute -bottom-[7px] left-0 right-0 h-[2px] bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.8)] rounded-t-full" />
            )}
          </button>
        </div>
        <div className="flex items-center gap-1 text-zinc-500">
          {activeTab === 'terminal' && (
            <>
              <button
                onClick={syncWithClaude}
                disabled={!claudeCwd}
                className={cn(
                  "flex items-center gap-1 mr-1 px-1.5 py-0.5 rounded border transition-colors",
                  claudeCwd
                    ? "bg-blue-500/10 border-blue-500/20 hover:bg-blue-500/20 text-blue-400"
                    : "bg-white/5 border-white/5 text-zinc-600 cursor-not-allowed"
                )}
                title={claudeCwd ? `Sync to: ${claudeCwd}` : "Claude cwd not available"}
              >
                <RefreshCw size={11} />
                <span className="text-[10px]">sync</span>
              </button>
              <button
                onClick={spawnNewTerminal}
                className="flex items-center gap-1 mr-2 px-1.5 py-0.5 rounded bg-white/5 border border-white/5 hover:bg-white/10 transition-colors"
              >
                <Plus size={12} />
                <span className="text-[10px]">bash</span>
              </button>
            </>
          )}
          <button onClick={clearTerminal} className="p-1 hover:text-zinc-200 hover:bg-white/5 rounded transition-colors" title="Clear">
            <Trash2 size={13} />
          </button>
          <button
            onClick={onMaximize}
            className="p-1 hover:text-zinc-200 hover:bg-white/5 rounded transition-colors"
            title={isMaximized ? "Restore" : "Maximize"}
          >
            {isMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            onClick={onClose}
            className="p-1 hover:text-zinc-200 hover:bg-white/5 rounded transition-colors"
            title="Close terminal"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Terminal Content */}
      <div className="flex-1 overflow-hidden relative">
        {/* Interactive PTY Terminal */}
        <div
          ref={ptyContainerRef}
          className={cn(
            "absolute inset-0",
            activeTab === 'terminal' ? "visible" : "invisible"
          )}
        />

        {/* Claude Output Terminal (read-only) */}
        <div
          ref={outputContainerRef}
          className={cn(
            "absolute inset-0",
            activeTab === 'output' ? "visible" : "invisible"
          )}
        />

        {/* Problems Panel */}
        {activeTab === 'problems' && (
          <div className="h-full overflow-auto p-2 custom-scrollbar">
            {problems.length === 0 ? (
              <div className="text-zinc-600 text-sm italic text-center py-8">
                No problems detected
              </div>
            ) : (
              <div className="space-y-1">
                {problems.map((problem) => (
                  <div
                    key={problem.id}
                    className={cn(
                      "flex items-start gap-2 px-2 py-1.5 rounded text-sm hover:bg-white/5 cursor-pointer",
                      problem.type === 'error' ? "text-red-400" : "text-yellow-400"
                    )}
                  >
                    <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{problem.message}</div>
                      {problem.file && (
                        <div className="text-xs text-zinc-500 truncate">
                          {problem.file}{problem.line ? `:${problem.line}` : ''}
                        </div>
                      )}
                    </div>
                    <div className="text-[10px] text-zinc-600">
                      {problem.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
})
