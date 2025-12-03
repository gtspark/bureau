import { createContext, useContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react'

const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:3006/ws`

type MessageHandler = (msg: Record<string, unknown>) => void

interface WebSocketContextValue {
  connected: boolean
  claudeRunning: boolean
  claudeCwd: string | null
  lastExplorerPath: string | null
  lastTerminalCwd: string | null
  projectRoot: string | null
  send: (message: object) => void
  subscribe: (handler: MessageHandler) => () => void
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null)

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false)
  const [claudeRunning, setClaudeRunning] = useState(false)
  const [claudeCwd, setClaudeCwd] = useState<string | null>(null)
  const [lastExplorerPath, setLastExplorerPath] = useState<string | null>(null)
  const [lastTerminalCwd, setLastTerminalCwd] = useState<string | null>(null)
  const [projectRoot, setProjectRoot] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const handlersRef = useRef<Set<MessageHandler>>(new Set())

  // Send a message
  const send = useCallback((message: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message))
    }
  }, [])

  // Subscribe to messages
  const subscribe = useCallback((handler: MessageHandler) => {
    handlersRef.current.add(handler)
    return () => {
      handlersRef.current.delete(handler)
    }
  }, [])

  // Manage WebSocket connection
  useEffect(() => {
    let isCleanedUp = false
    let reconnectTimeout: number | null = null

    const connect = () => {
      if (isCleanedUp) return

      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        if (isCleanedUp) return
        setConnected(true)
      }

      ws.onerror = () => {
        // Error will be followed by onclose, no action needed
      }

      ws.onclose = () => {
        if (isCleanedUp) return
        setConnected(false)
        setClaudeRunning(false)
        // Retry quickly on first failure, slower after
        reconnectTimeout = window.setTimeout(connect, 500)
      }

      ws.onmessage = (event) => {
        if (isCleanedUp) return

        try {
          const msg = JSON.parse(event.data)

          // Track Claude running state from messages
          if (msg.type === 'connected') {
            // Initial connection includes Claude status and session info
            setClaudeRunning(!!msg.claudeRunning)
            // Set initial values from session
            const session = msg.session as {
              projectRoot?: string
              lastExplorerPath?: string
              lastTerminalCwd?: string
              lastClaudeCwd?: string
            } | undefined
            if (session?.projectRoot) {
              setProjectRoot(session.projectRoot)
              setClaudeCwd(session.lastClaudeCwd || session.projectRoot)
            }
            setLastExplorerPath(session?.lastExplorerPath || null)
            setLastTerminalCwd(session?.lastTerminalCwd || null)
          } else if (msg.type === 'sessions:switched') {
            // Session switch includes Claude status for new session
            setClaudeRunning(!!msg.claudeRunning)
            // Update values from new session
            const session = msg.session as {
              projectRoot?: string
              lastExplorerPath?: string
              lastTerminalCwd?: string
              lastClaudeCwd?: string
            } | undefined
            if (session?.projectRoot) {
              setProjectRoot(session.projectRoot)
              setClaudeCwd(session.lastClaudeCwd || session.projectRoot)
            }
            setLastExplorerPath(session?.lastExplorerPath || null)
            setLastTerminalCwd(session?.lastTerminalCwd || null)
          } else if (msg.type === 'claude:spawned') {
            setClaudeRunning(true)
          } else if (msg.type === 'claude:killed' || msg.type === 'claude:exit') {
            setClaudeRunning(false)
          } else if (msg.type === 'claude:message') {
            const m = msg.message as Record<string, unknown> | undefined
            if (m?.type === 'system') {
              // Track cwd from system init message (initial project root)
              if (m.subtype === 'init' && m.cwd) {
                console.log('[WebSocket] initial cwd:', m.cwd)
                setClaudeCwd(m.cwd as string)
                setClaudeRunning(true)
              }
            }
            // Track cwd from tool_use - infer from absolute paths Claude uses
            if (m?.type === 'assistant') {
              const message = m.message as Record<string, unknown> | undefined
              const content = message?.content as Array<Record<string, unknown>> | undefined
              if (content) {
                for (const block of content) {
                  if (block.type === 'tool_use') {
                    const toolName = block.name as string
                    const input = block.input as Record<string, unknown> | undefined
                    if (!input) continue

                    let extractedPath: string | null = null

                    // Extract path from different tools
                    if (toolName === 'Bash' || toolName === 'bash') {
                      const command = input.command as string | undefined
                      if (command) {
                        // First check for cd command: cd /path or cd /path && ...
                        const cdMatch = command.match(/^cd\s+["']?([^"'\n]+?)["']?\s*(?:&&|$)/)
                        if (cdMatch && cdMatch[1].trim().startsWith('/')) {
                          extractedPath = cdMatch[1].trim()
                        } else {
                          // Extract first absolute path from command (e.g., ls -la /opt/vodbase/storypath)
                          const pathMatch = command.match(/\s(\/[^\s"']+)/)
                          if (pathMatch) {
                            extractedPath = pathMatch[1]
                          }
                        }
                      }
                    } else if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
                      const filePath = input.file_path as string | undefined
                      if (filePath?.startsWith('/')) {
                        extractedPath = filePath
                      }
                    } else if (toolName === 'Glob' || toolName === 'Grep') {
                      const searchPath = input.path as string | undefined
                      if (searchPath?.startsWith('/')) {
                        extractedPath = searchPath
                      }
                    }

                    // Get directory from path and set as cwd
                    if (extractedPath) {
                      // Only treat as file if it has a file extension (e.g., .ts, .js, .json)
                      // Paths without extensions are assumed to be directories
                      const hasFileExtension = /\.[a-zA-Z0-9]{1,10}$/.test(extractedPath)
                      const dir = hasFileExtension
                        ? extractedPath.replace(/\/[^/]+$/, '')  // Get parent dir for files
                        : extractedPath.replace(/\/$/, '')       // Just trim trailing slash for dirs
                      if (dir && dir !== claudeCwd) {
                        console.log('[WebSocket] cwd from tool path:', dir, '(from', extractedPath, ')')
                        setClaudeCwd(dir)
                      }
                    }
                  }
                }
              }
            }
          }

          // Notify all subscribers
          for (const handler of handlersRef.current) {
            try {
              handler(msg)
            } catch {
              // Ignore handler errors
            }
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
  }, [])

  return (
    <WebSocketContext.Provider value={{ connected, claudeRunning, claudeCwd, lastExplorerPath, lastTerminalCwd, projectRoot, send, subscribe }}>
      {children}
    </WebSocketContext.Provider>
  )
}

export function useWebSocket() {
  const context = useContext(WebSocketContext)
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider')
  }
  return context
}

// Hook for subscribing to specific message types
export function useWebSocketMessages(handler: MessageHandler, deps: unknown[] = []) {
  const { subscribe } = useWebSocket()

  useEffect(() => {
    return subscribe(handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, ...deps])
}
