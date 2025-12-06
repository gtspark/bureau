import { useEffect, useState, useRef, useCallback } from 'react'
import { useWebSocket, useWebSocketMessages } from '../contexts/WebSocketContext'
import { useSession } from '../contexts/SessionContext'
import { SessionSwitcher } from './SessionSwitcher'
import { Send, Bot, User, Sparkles, MoreHorizontal, X, ChevronDown, Brain, CheckCircle2, Circle, RefreshCw, Square, AlertTriangle, ExternalLink } from 'lucide-react'
import { cn } from '../lib/cn'
import { marked } from 'marked'

// Configure marked for GFM and line breaks
marked.setOptions({
  gfm: true,
  breaks: true,
})

// Custom renderer to open links in new tab
const renderer = new marked.Renderer()
renderer.link = ({ href, title, text }) => {
  const titleAttr = title ? ` title="${title}"` : ''
  return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`
}
marked.use({ renderer })

// Prefix used when context refresh is prepended to messages after compaction
const CONTEXT_REFRESH_PREFIX = '[CONTEXT:'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  isStreaming?: boolean
  // Tools that were active when this message was received
  toolsSnapshot?: ToolActivity[]
}

interface ThinkingState {
  id: string
  content: string
  isActive: boolean
  isExpanded: boolean
  startTime: number
}

interface ToolActivity {
  id: string
  name: string
  input?: Record<string, unknown>
  isActive: boolean
  startTime: number
  endTime?: number
}

interface ChatProps {
  onClose?: () => void
  onSwitchToOutput?: (toolId?: string) => void
}

// Format model name for display (e.g. "claude-sonnet-4-5-20250929" -> "Sonnet 4.5")
function formatModelName(model: string | null): string | null {
  if (!model) return null

  // Match patterns like claude-sonnet-4-5, claude-opus-4-5, etc.
  const match = model.match(/claude-(\w+)-(\d+)-(\d+)/)
  if (match) {
    const [, variant, major, minor] = match
    const capitalizedVariant = variant.charAt(0).toUpperCase() + variant.slice(1)
    return `${capitalizedVariant} ${major}.${minor}`
  }

  // Fallback: just return the model name
  return model
}

export function Chat({ onClose, onSwitchToOutput }: ChatProps) {
  const { connected, claudeRunning, claudeModel, send, cliStatus, refreshCliStatus } = useWebSocket()
  const { activeSession } = useSession()
  // Store messages per session so background sessions keep accumulating
  const [sessionMessages, setSessionMessages] = useState<Map<string, Message[]>>(new Map())
  const [input, setInput] = useState('')
  const [isWaiting, setIsWaiting] = useState(false)
  const [thinking, setThinking] = useState<ThinkingState | null>(null)
  const [toolActivities, setToolActivities] = useState<ToolActivity[]>([])
  const toolActivitiesRef = useRef<ToolActivity[]>([])
  const [isProcessing, setIsProcessing] = useState(false) // True while Claude is working between tools
  const [compactionNotice, setCompactionNotice] = useState<{ trigger: string; preTokens: number } | null>(null)
  const [isCompacting, setIsCompacting] = useState(false)
  const [messageQueue, setMessageQueue] = useState<string[]>([])
  const messageQueueRef = useRef<string[]>([])

  // Get messages for current session
  const activeSessionId = activeSession?.id
  const messages = activeSessionId ? (sessionMessages.get(activeSessionId) || []) : []

  // Helper to update messages for a specific session
  const updateSessionMessages = useCallback((sessionId: string, updater: (prev: Message[]) => Message[]) => {
    setSessionMessages(prev => {
      const newMap = new Map(prev)
      const current = newMap.get(sessionId) || []
      newMap.set(sessionId, updater(current))
      return newMap
    })
  }, [])

  // Keep ref in sync with state for use in callbacks
  useEffect(() => {
    messageQueueRef.current = messageQueue
  }, [messageQueue])

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const doSendMessageRef = useRef<(text: string) => void>(() => {})

  // Focus chat input on mount
  useEffect(() => {
    // Small delay to ensure DOM is ready and terminal hasn't stolen focus
    const timer = setTimeout(() => {
      inputRef.current?.focus()
    }, 100)
    return () => clearTimeout(timer)
  }, [])

  // Helper to update both state and ref synchronously
  const updateToolActivities = useCallback((updater: (prev: ToolActivity[]) => ToolActivity[]) => {
    setToolActivities(prev => {
      const next = updater(prev)
      toolActivitiesRef.current = next
      return next
    })
  }, [])

  // Load messages from session history when session changes
  useEffect(() => {
    if (activeSession?.history) {
      const restored: Message[] = []
      // Track pending tools to attach to the next text message
      let pendingTools: ToolActivity[] = []

      for (const entry of activeSession.history) {
        if (entry.type === 'user') {
          restored.push({
            id: entry.timestamp,
            role: 'user',
            content: entry.content,
            timestamp: new Date(entry.timestamp)
          })
        } else if (entry.type === 'claude') {
          try {
            const m = JSON.parse(entry.content)
            if (m.type === 'assistant' && m.message?.content) {
              // First pass: collect tools from this message
              for (const block of m.message.content) {
                if (block.type === 'tool_use') {
                  pendingTools.push({
                    id: block.id,
                    name: block.name,
                    input: block.input,
                    isActive: false,
                    startTime: new Date(entry.timestamp).getTime()
                  })
                }
              }
              // Second pass: find text and attach tools
              for (const block of m.message.content) {
                if (block.type === 'text') {
                  restored.push({
                    id: `${entry.timestamp}-${restored.length}`,
                    role: 'assistant',
                    content: block.text,
                    timestamp: new Date(entry.timestamp),
                    toolsSnapshot: pendingTools.length > 0 ? [...pendingTools] : undefined
                  })
                  pendingTools = [] // Clear after attaching
                }
              }
            }
          } catch {
            // Skip invalid entries
          }
        }
      }
      // Only restore if we don't already have messages for this session
      // (they may have accumulated while in background)
      setSessionMessages(prev => {
        if (!prev.has(activeSession.id) || prev.get(activeSession.id)!.length === 0) {
          const newMap = new Map(prev)
          newMap.set(activeSession.id, restored)
          return newMap
        }
        return prev
      })
    }
    // Reset UI state on session change (but not messages)
    setThinking(null)
    updateToolActivities(() => [])
    setIsWaiting(false)
    setIsProcessing(false)
  }, [activeSession?.id])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, thinking, toolActivities.length, isWaiting, isProcessing, isCompacting])

  // Subscribe to messages - handle Claude CLI stream-json format
  useWebSocketMessages((msg) => {
    switch (msg.type) {
      case 'claude:message': {
        // Get sessionId from message - route to correct session
        const msgSessionId = msg.sessionId as string | undefined
        // Only process UI state (thinking, tools, waiting) for active session
        const isActiveSession = msgSessionId === activeSessionId

        if (msg.message) {
          const m = msg.message as Record<string, unknown>

          // Handle assistant messages - contains tool_use and text blocks in content array
          if (m.type === 'assistant') {
            const message = m.message as Record<string, unknown> | undefined
            const content = message?.content as Array<Record<string, unknown>> | undefined

            if (content) {
              // First pass: collect all tools from this message
              const newTools: ToolActivity[] = []
              let textContent: string | null = null
              let thinkingContent: string | null = null

              for (const block of content) {
                if (block.type === 'tool_use') {
                  const toolId = block.id as string
                  const toolName = block.name as string
                  const toolInput = block.input as Record<string, unknown> | undefined
                  // Only add if not already tracked
                  if (!toolActivitiesRef.current.some(t => t.id === toolId)) {
                    newTools.push({ id: toolId, name: toolName, input: toolInput, isActive: true, startTime: Date.now() })
                  }
                } else if (block.type === 'thinking') {
                  thinkingContent = block.thinking as string
                } else if (block.type === 'text') {
                  const text = block.text as string
                  if (text) {
                    textContent = text
                  }
                }
              }

              // Handle thinking - only for active session
              if (thinkingContent && isActiveSession) {
                const id = `thinking-${Date.now()}`
                setThinking({ id, content: thinkingContent, isActive: true, isExpanded: true, startTime: Date.now() })
                // Don't clear isWaiting - keep it true until result comes
              }

              // If we have new tools, add them - only for active session
              if (newTools.length > 0 && isActiveSession) {
                updateToolActivities(prev => [...prev, ...newTools])
                // Don't clear isWaiting - keep it true until result comes
                setIsProcessing(false)
              }

              // If we have text, create message - route to correct session
              if (textContent && msgSessionId) {
                // Capture current tools PLUS new tools from this message (only for active session)
                const allTools = isActiveSession ? [...toolActivitiesRef.current, ...newTools] : []
                updateSessionMessages(msgSessionId, prev => [...prev, {
                  id: Date.now().toString(),
                  role: 'assistant',
                  content: textContent as string,
                  timestamp: new Date(),
                  toolsSnapshot: allTools.length > 0 ? allTools : undefined
                }])
                // Clear tools after attaching to message - only for active session
                if (isActiveSession) {
                  updateToolActivities(() => [])
                  // Don't clear isWaiting here - only clear on 'result' message
                  setIsProcessing(false)
                  setThinking(null)
                }
              }
            }
          }

          // Handle user messages (tool results) - mark tool as complete (only for active session)
          else if (m.type === 'user' && isActiveSession) {
            const message = m.message as Record<string, unknown> | undefined
            const content = message?.content as Array<Record<string, unknown>> | undefined

            if (content) {
              for (const block of content) {
                if (block.type === 'tool_result') {
                  const toolUseId = block.tool_use_id as string
                  // Mark this specific tool as complete with end time
                  updateToolActivities(prev =>
                    prev.map(t => t.id === toolUseId ? { ...t, isActive: false, endTime: Date.now() } : t)
                  )
                  // Claude is now processing the result - show activity
                  setIsProcessing(true)
                }
              }
            }
          }

          else if (m.type === 'system' && m.subtype === 'init') {
            // Don't clear isWaiting here - wait for actual response
            // The init message is just metadata, not the response
          }

          else if (m.type === 'system' && m.subtype === 'status' && isActiveSession) {
            const status = m.status as string
            if (status === 'compacting') {
              setIsCompacting(true)
            }
          }

          else if (m.type === 'result' && isActiveSession) {
            // Final result - clear all activity states (only for active session)
            setIsProcessing(false)
            setThinking(prev => prev ? { ...prev, isActive: false, isExpanded: false } : null)

            // Check if there are queued messages to send
            if (messageQueueRef.current.length > 0) {
              const [nextMessage, ...rest] = messageQueueRef.current
              setMessageQueue(rest)
              // Small delay to let UI update before sending next
              setTimeout(() => {
                doSendMessageRef.current(nextMessage)
              }, 100)
            } else {
              setIsWaiting(false)
            }
          }
        }
        break
      }

      case 'claude:exit':
        // Only clear UI state if this exit is for active session
        if (msg.sessionId === activeSessionId) {
          setThinking(null)
          updateToolActivities(() => [])
          setIsCompacting(false)

          // Process queued messages if any
          if (messageQueueRef.current.length > 0) {
            const [nextMessage, ...rest] = messageQueueRef.current
            setMessageQueue(rest)
            setTimeout(() => {
              doSendMessageRef.current(nextMessage)
            }, 100)
          } else {
            setIsWaiting(false)
          }
        }
        break

      case 'claude:error': {
        const errorSessionId = msg.sessionId as string | undefined
        if (errorSessionId) {
          updateSessionMessages(errorSessionId, prev => [...prev, {
            id: Date.now().toString(),
            role: 'assistant',
            content: `Error: ${msg.message}`,
            timestamp: new Date()
          }])
        }
        if (errorSessionId === activeSessionId) {
          setThinking(null)
          updateToolActivities(() => [])
          setIsWaiting(false)
          setIsCompacting(false)
        }
        break
      }

      case 'claude:spawned':
        break

      case 'claude:compacted':
        // Show compaction notice briefly - only for active session
        if (msg.sessionId === activeSessionId) {
          setIsCompacting(false)
          setCompactionNotice({
            trigger: msg.trigger as string || 'auto',
            preTokens: msg.preTokens as number || 0
          })
          // Auto-dismiss after 5 seconds
          setTimeout(() => setCompactionNotice(null), 5000)
        }
        break
    }
  }, [activeSessionId, updateSessionMessages, updateToolActivities])

  // Actually send a message to Claude (internal, doesn't check queue)
  const doSendMessage = useCallback((text: string) => {
    if (!activeSessionId) return
    updateSessionMessages(activeSessionId, prev => [...prev, {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: new Date()
    }])
    setIsWaiting(true)
    setThinking(null)
    updateToolActivities(() => [])
    send({ type: 'claude:input', text })
  }, [send, updateToolActivities, activeSessionId, updateSessionMessages])

  // Keep ref updated for use in message handler
  useEffect(() => {
    doSendMessageRef.current = doSendMessage
  }, [doSendMessage])

  const sendMessage = useCallback((e?: React.FormEvent) => {
    e?.preventDefault()
    const text = input.trim()
    if (!text || !connected) return

    if (isWaiting) {
      // Claude is busy - queue the message
      setMessageQueue(prev => [...prev, text])
    } else {
      doSendMessage(text)
    }
    setInput('')
  }, [input, connected, isWaiting, doSendMessage])

  // Stop Claude and clear waiting state
  const stopClaude = useCallback(() => {
    send({ type: 'claude:kill' })
    setIsWaiting(false)
    setIsProcessing(false)
    setThinking(null)
    updateToolActivities(() => [])
  }, [send, updateToolActivities])

  const toggleThinking = useCallback(() => {
    setThinking(prev => prev ? { ...prev, isExpanded: !prev.isExpanded } : null)
  }, [])

  // Format elapsed time
  const formatElapsed = useCallback((startTime: number, endTime?: number) => {
    const elapsed = ((endTime || Date.now()) - startTime) / 1000
    if (elapsed < 60) return `${elapsed.toFixed(1)}s`
    const mins = Math.floor(elapsed / 60)
    const secs = Math.floor(elapsed % 60)
    return `${mins}m ${secs}s`
  }, [])

  // Prettify tool names
  const prettyToolName = useCallback((name: string, input?: Record<string, unknown>) => {
    const toolLabels: Record<string, string> = {
      'Read': 'Read',
      'Write': 'Write',
      'Edit': 'Edit',
      'Bash': 'Run',
      'Glob': 'Search',
      'Grep': 'Search',
      'Task': 'Agent',
      'WebFetch': 'Fetch',
      'WebSearch': 'Web',
      'TodoWrite': 'Tasks',
    }
    const label = toolLabels[name] || name
    // Try to extract a meaningful target from input
    if (input) {
      const filePath = input.file_path || input.path || input.pattern
      if (typeof filePath === 'string') {
        const shortPath = filePath.split('/').slice(-2).join('/')
        return { label, target: shortPath }
      }
      if (input.command && typeof input.command === 'string') {
        const cmd = (input.command as string).length > 30
          ? (input.command as string).substring(0, 30) + '...'
          : input.command as string
        return { label, target: cmd }
      }
      if (input.query && typeof input.query === 'string') {
        return { label, target: input.query as string }
      }
    }
    return { label, target: null }
  }, [])

  // Handle tool click - switch to output tab and scroll to tool
  const handleToolClick = useCallback((toolId: string) => {
    onSwitchToOutput?.(toolId)
  }, [onSwitchToOutput])

  // Strip context refresh prefix from user messages (added after compaction)
  const stripContextPrefix = useCallback((content: string): string => {
    if (content.startsWith(CONTEXT_REFRESH_PREFIX)) {
      // Find the closing bracket and remove everything up to the next line
      const endBracket = content.indexOf(']')
      if (endBracket !== -1) {
        // Skip past the bracket and any following newlines
        let start = endBracket + 1
        while (start < content.length && (content[start] === '\n' || content[start] === '\r')) {
          start++
        }
        return content.substring(start)
      }
    }
    return content
  }, [])

  // Force re-render for elapsed time updates and activity animation
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const hasActiveWork = thinking?.isActive || toolActivities.some(t => t.isActive) || isWaiting || isProcessing || isCompacting
    if (!hasActiveWork) return
    const interval = setInterval(() => setTick(n => n + 1), 100)
    return () => clearInterval(interval)
  }, [thinking?.isActive, toolActivities, isWaiting, isProcessing, isCompacting])

  // Activity pulse animation based on tick
  const pulseOpacity = 0.4 + Math.sin(tick * 0.3) * 0.3

  return (
    <div className="h-full flex flex-col bg-transparent">
      {/* Header */}
      <div className="h-10 px-4 flex items-center justify-between border-b border-white/5 bg-zinc-900/40 backdrop-blur-md shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 font-semibold text-zinc-100 text-xs tracking-wide">
            <div className="p-1 rounded bg-blue-500/10">
              <Sparkles size={12} className="text-blue-400" />
            </div>
            <span>CLAUDE</span>
            {claudeModel && (
              <span className="text-[10px] font-normal italic text-zinc-500">
                ({formatModelName(claudeModel)})
              </span>
            )}
          </div>
          <SessionSwitcher />
        </div>
        <div className="flex items-center gap-1 text-zinc-500">
          <button className="p-1.5 hover:text-zinc-300 hover:bg-white/5 rounded transition-colors">
            <MoreHorizontal size={14} />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 hover:text-zinc-300 hover:bg-white/5 rounded transition-colors"
            title="Close chat panel"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar scroll-smooth">
        {/* CLI Setup Required Notice */}
        {cliStatus && (!cliStatus.installed || !cliStatus.authenticated) && (
          <div className="bg-amber-950/30 border border-amber-500/30 rounded-lg p-4 mb-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-amber-500/20 flex items-center justify-center shrink-0">
                <AlertTriangle size={20} className="text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-amber-200 font-semibold text-sm mb-1">
                  {!cliStatus.installed ? 'Claude CLI Not Installed' : 'Claude CLI Not Authenticated'}
                </h3>
                <p className="text-amber-200/70 text-xs mb-3">
                  {!cliStatus.installed
                    ? 'Bureau requires Claude Code CLI to communicate with Claude.'
                    : 'Claude Code CLI needs to be authenticated before use.'
                  }
                </p>

                {!cliStatus.installed ? (
                  <div className="space-y-2">
                    <p className="text-zinc-400 text-xs">Install Claude Code CLI:</p>
                    <code className="block bg-zinc-900/80 text-cyan-400 px-3 py-2 rounded text-xs font-mono">
                      npm install -g @anthropic-ai/claude-code
                    </code>
                    <p className="text-zinc-500 text-[10px]">
                      Requires Node.js 18+ and a Claude Max subscription
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-zinc-400 text-xs">Run this command in a terminal:</p>
                    <code className="block bg-zinc-900/80 text-cyan-400 px-3 py-2 rounded text-xs font-mono">
                      claude
                    </code>
                    <p className="text-zinc-500 text-[10px]">
                      Follow the prompts to authenticate with your Anthropic account
                    </p>
                  </div>
                )}

                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={refreshCliStatus}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded text-xs font-medium transition-colors"
                  >
                    <RefreshCw size={12} />
                    Check Again
                  </button>
                  <a
                    href="https://docs.anthropic.com/en/docs/claude-code/getting-started"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-3 py-1.5 text-zinc-400 hover:text-zinc-300 text-xs transition-colors"
                  >
                    <ExternalLink size={12} />
                    Documentation
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}

        {messages.length === 0 && !isWaiting && !thinking ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-600/20 flex items-center justify-center mb-4 border border-white/5">
              <Bot size={28} className="text-indigo-400" />
            </div>
            <p className="text-zinc-400 text-sm">
              {!connected ? 'Connecting...' :
               cliStatus && !cliStatus.installed ? 'Install Claude CLI to get started' :
               cliStatus && !cliStatus.authenticated ? 'Authenticate Claude CLI to get started' :
               'Send a message to start...'}
            </p>
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <div key={msg.id}>
                {/* Render tools that were used before this message */}
                {msg.toolsSnapshot && msg.toolsSnapshot.length > 0 && (
                  <div className="space-y-1 mb-3">
                    {msg.toolsSnapshot.map((tool) => {
                      const { label, target } = prettyToolName(tool.name, tool.input)
                      return (
                        <button
                          key={tool.id}
                          onClick={() => handleToolClick(tool.id)}
                          className="flex items-center gap-3 group w-full text-left"
                        >
                          <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 bg-emerald-500/20 text-emerald-400">
                            <CheckCircle2 size={12} />
                          </div>
                          <div className="flex items-center gap-2 px-2 py-1 rounded text-[11px] font-medium bg-zinc-800/50 text-zinc-500 group-hover:bg-zinc-800 transition-colors">
                            <span className="font-semibold">{label}</span>
                            {target && (
                              <span className="text-zinc-500 font-mono truncate max-w-[200px]">{target}</span>
                            )}
                            <span className="text-[10px] tabular-nums text-zinc-600">
                              {formatElapsed(tool.startTime, tool.endTime)}
                            </span>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}

                <div className={cn("flex gap-3", msg.role === 'user' ? "flex-row-reverse" : "flex-row")}>
                  <div className={cn(
                    "w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5",
                    msg.role === 'assistant'
                      ? "bg-indigo-500/20 text-indigo-400"
                      : "bg-zinc-700 text-zinc-400"
                  )}>
                    {msg.role === 'assistant' ? <Bot size={12} /> : <User size={12} />}
                  </div>

                  <div className={cn(
                    "flex flex-col gap-1 max-w-[85%]",
                    msg.role === 'user' ? "items-end" : "items-start"
                  )}>
                    <div className={cn(
                      "px-3 py-2 rounded-lg text-sm leading-relaxed overflow-hidden",
                      msg.role === 'user'
                        ? "bg-blue-600 text-white font-mono whitespace-pre-wrap break-words"
                        : "bg-zinc-800/60 text-zinc-200 border border-white/5 prose prose-invert prose-sm max-w-full prose-p:my-1.5 prose-p:leading-relaxed prose-headings:mt-3 prose-headings:mb-1 prose-h1:text-base prose-h2:text-sm prose-h3:text-sm prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0 prose-code:text-cyan-400 prose-code:bg-zinc-900/80 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none prose-code:font-normal prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-white/10 prose-pre:overflow-x-auto prose-pre:my-2 prose-table:border-collapse prose-table:my-2 prose-th:border prose-th:border-zinc-700 prose-th:bg-zinc-900 prose-th:px-2 prose-th:py-1 prose-td:border prose-td:border-zinc-700 prose-td:px-2 prose-td:py-1 prose-hr:my-3 prose-blockquote:my-1.5 prose-blockquote:border-zinc-600 [&>*:first-child]:mt-0 break-words"
                    )}>
                      {msg.role === 'user' ? (
                        stripContextPrefix(msg.content)
                      ) : (
                        <div
                          className="markdown-content"
                          dangerouslySetInnerHTML={{ __html: marked.parse(msg.content) as string }}
                        />
                      )}
                      {msg.isStreaming && (
                        <span className="inline-block w-2 h-4 ml-0.5 bg-indigo-400 animate-pulse" />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}

            {/* Thinking indicator */}
            {thinking && (
              <div className="flex gap-3">
                <div
                  className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5 bg-amber-500/20 text-amber-400"
                  style={thinking.isActive ? { opacity: pulseOpacity + 0.5 } : undefined}
                >
                  <Brain size={12} />
                </div>
                <div className="flex-1 max-w-[85%]">
                  <button
                    onClick={toggleThinking}
                    className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-400 text-xs font-medium hover:bg-amber-500/20 transition-colors"
                  >
                    <span>
                      {thinking.isActive ? `Thinking... ${formatElapsed(thinking.startTime)}` : 'Thought process'}
                    </span>
                    <ChevronDown
                      size={12}
                      className={cn("transition-transform", thinking.isExpanded && "rotate-180")}
                    />
                  </button>
                  {thinking.isExpanded && thinking.content && (
                    <div className="mt-2 px-3 py-2 bg-zinc-900/80 border border-amber-500/10 rounded-lg text-xs text-zinc-400 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto custom-scrollbar">
                      {thinking.content}
                      {thinking.isActive && (
                        <span className="inline-block w-1.5 h-3 ml-0.5 bg-amber-400 animate-pulse" />
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Tool activity indicators - stacked vertically */}
            {toolActivities.length > 0 && (
              <div className="space-y-1">
                {toolActivities.map((tool) => {
                  const { label, target } = prettyToolName(tool.name, tool.input)
                  return (
                    <button
                      key={tool.id}
                      onClick={() => handleToolClick(tool.id)}
                      className="flex items-center gap-3 group w-full text-left"
                    >
                      <div
                        className={cn(
                          "w-6 h-6 rounded-md flex items-center justify-center shrink-0",
                          tool.isActive
                            ? "bg-cyan-500/20 text-cyan-400"
                            : "bg-emerald-500/20 text-emerald-400"
                        )}
                        style={tool.isActive ? { opacity: pulseOpacity + 0.5 } : undefined}
                      >
                        {tool.isActive ? (
                          <Circle size={10} fill="currentColor" />
                        ) : (
                          <CheckCircle2 size={12} />
                        )}
                      </div>
                      <div className={cn(
                        "flex items-center gap-2 px-2 py-1 rounded text-[11px] font-medium transition-colors",
                        tool.isActive
                          ? "bg-cyan-500/10 text-cyan-400 group-hover:bg-cyan-500/20"
                          : "bg-zinc-800/50 text-zinc-500 group-hover:bg-zinc-800"
                      )}>
                        <span className="font-semibold">{label}</span>
                        {target && (
                          <span className="text-zinc-500 font-mono truncate max-w-[200px]">{target}</span>
                        )}
                        <span className={cn(
                          "text-[10px] tabular-nums",
                          tool.isActive ? "text-cyan-500/70" : "text-zinc-600"
                        )}>
                          {formatElapsed(tool.startTime, tool.endTime)}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            {/* Processing indicator - shows between tool completion and next action */}
            {isProcessing && !toolActivities.some(t => t.isActive) && (
              <div className="flex items-center gap-3">
                <div
                  className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 bg-violet-500/20 text-violet-400"
                  style={{ opacity: pulseOpacity + 0.5 }}
                >
                  <Circle size={8} fill="currentColor" />
                </div>
                <div
                  className="flex items-center gap-2 px-2 py-1 rounded bg-violet-500/10 text-violet-400 text-[11px] font-medium"
                  style={{ opacity: pulseOpacity + 0.5 }}
                >
                  <span>Processing...</span>
                </div>
              </div>
            )}

            {/* Compacting indicator */}
            {isCompacting && (
              <div className="flex gap-3">
                <div
                  className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5 bg-orange-500/20 text-orange-400"
                  style={{ opacity: pulseOpacity + 0.5 }}
                >
                  <RefreshCw size={12} className="animate-spin" />
                </div>
                <div
                  className="bg-orange-500/10 border border-orange-500/20 px-3 py-2 rounded-lg"
                  style={{ opacity: pulseOpacity + 0.5 }}
                >
                  <span className="text-orange-400 text-sm font-mono">Compacting context...</span>
                  <span className="text-orange-400/60 text-xs ml-2">(summarizing conversation history)</span>
                </div>
              </div>
            )}

            {/* Waiting indicator (before any activity) */}
            {isWaiting && !thinking && toolActivities.length === 0 && !isCompacting && (
              <div className="flex gap-3">
                <div
                  className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5 bg-indigo-500/20 text-indigo-400"
                  style={{ opacity: pulseOpacity + 0.5 }}
                >
                  <Bot size={12} />
                </div>
                <div
                  className="bg-zinc-800/60 border border-white/5 px-3 py-2 rounded-lg"
                  style={{ opacity: pulseOpacity + 0.5 }}
                >
                  <span className="text-zinc-400 text-sm font-mono">Waiting for response...</span>
                </div>
              </div>
            )}

            {/* Compaction notice */}
            {compactionNotice && (
              <div className="flex gap-3">
                <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5 bg-orange-500/20 text-orange-400">
                  <RefreshCw size={12} />
                </div>
                <div className="flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 px-3 py-1.5 rounded-lg">
                  <span className="text-orange-400 text-xs">
                    Context compacted ({Math.round(compactionNotice.preTokens / 1000)}k tokens) — context refreshed
                  </span>
                  <button
                    onClick={() => setCompactionNotice(null)}
                    className="text-orange-400/60 hover:text-orange-400 transition-colors"
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-white/5 bg-zinc-900/60">
        {/* Queued messages */}
        {messageQueue.length > 0 && (
          <div className="mb-2 space-y-1">
            {messageQueue.map((queuedMsg, idx) => (
              <div key={idx} className="flex items-center gap-2 text-[11px]">
                <span className="text-zinc-500 shrink-0">#{idx + 1}</span>
                <span className="text-zinc-400 font-mono truncate flex-1">{queuedMsg}</span>
                <button
                  onClick={() => setMessageQueue(prev => prev.filter((_, i) => i !== idx))}
                  className="text-zinc-500 hover:text-zinc-300 shrink-0"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={sendMessage} className="flex items-center gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendMessage()
              } else if (e.key === 'ArrowUp' && !input && messageQueue.length > 0) {
                // Pop last queued message back into input
                e.preventDefault()
                const lastMsg = messageQueue[messageQueue.length - 1]
                setMessageQueue(prev => prev.slice(0, -1))
                setInput(lastMsg)
              }
            }}
            placeholder={
              isCompacting ? "Compacting context..." :
              cliStatus && !cliStatus.installed ? "Install Claude CLI first..." :
              cliStatus && !cliStatus.authenticated ? "Authenticate Claude CLI first..." :
              "Ask Claude..."
            }
            disabled={!connected || isCompacting || !!(cliStatus && (!cliStatus.installed || !cliStatus.authenticated))}
            className="flex-1 bg-zinc-950 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500/50 resize-y min-h-[160px] max-h-[400px] font-mono disabled:opacity-50"
            rows={8}
          />
          {isWaiting ? (
            <button
              type="button"
              onClick={stopClaude}
              className="p-2 rounded transition-colors self-end mb-1 bg-red-600 hover:bg-red-500 text-white"
              title="Stop Claude"
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              type="submit"
              className={cn(
                "p-2 rounded transition-colors self-end mb-1",
                input.trim() && connected && cliStatus?.installed && cliStatus?.authenticated
                  ? "bg-blue-600 hover:bg-blue-500 text-white"
                  : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
              )}
              disabled={!input.trim() || !connected || isCompacting || !cliStatus?.installed || !cliStatus?.authenticated}
            >
              <Send size={14} />
            </button>
          )}
        </form>
        <div className="mt-1.5 flex items-center justify-between text-[9px] text-zinc-500 px-1">
          <span><kbd className="bg-zinc-800 px-1 rounded">Enter</kbd> send</span>
          <span className={cn(
            "font-medium",
            cliStatus && !cliStatus.installed ? "text-red-500/60" :
            cliStatus && !cliStatus.authenticated ? "text-amber-500/60" :
            claudeRunning ? "text-green-500/60" : "text-zinc-600"
          )}>
            {cliStatus && !cliStatus.installed ? 'NOT INSTALLED' :
             cliStatus && !cliStatus.authenticated ? 'NOT AUTHENTICATED' :
             claudeRunning ? 'READY' : 'IDLE'}
          </span>
        </div>
      </div>
    </div>
  )
}
