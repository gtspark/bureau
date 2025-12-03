import { useEffect, useState, useRef, useCallback } from 'react'
import { useWebSocket, useWebSocketMessages } from '../contexts/WebSocketContext'
import { useSession } from '../contexts/SessionContext'
import { SessionSwitcher } from './SessionSwitcher'
import { Send, Bot, User, Sparkles, MoreHorizontal, X, ChevronDown, Brain, CheckCircle2, Circle, RefreshCw } from 'lucide-react'
import { cn } from '../lib/cn'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

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

export function Chat({ onClose, onSwitchToOutput }: ChatProps) {
  const { connected, claudeRunning, send } = useWebSocket()
  const { activeSession } = useSession()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isWaiting, setIsWaiting] = useState(false)
  const [thinking, setThinking] = useState<ThinkingState | null>(null)
  const [toolActivities, setToolActivities] = useState<ToolActivity[]>([])
  const toolActivitiesRef = useRef<ToolActivity[]>([])
  const [isProcessing, setIsProcessing] = useState(false) // True while Claude is working between tools
  const [compactionNotice, setCompactionNotice] = useState<{ trigger: string; preTokens: number } | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)

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
              for (const block of m.message.content) {
                if (block.type === 'text') {
                  restored.push({
                    id: `${entry.timestamp}-${restored.length}`,
                    role: 'assistant',
                    content: block.text,
                    timestamp: new Date(entry.timestamp)
                  })
                }
                // Skip tool_use - don't show in chat
              }
            }
          } catch {
            // Skip invalid entries
          }
        }
      }
      setMessages(restored)
    } else {
      setMessages([])
    }
    // Reset state on session change
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
  }, [messages, thinking, toolActivities.length, isWaiting, isProcessing])

  // Subscribe to messages - handle Claude CLI stream-json format
  useWebSocketMessages((msg) => {
    switch (msg.type) {
      case 'claude:message':
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

              // Handle thinking
              if (thinkingContent) {
                const id = `thinking-${Date.now()}`
                setThinking({ id, content: thinkingContent, isActive: true, isExpanded: true, startTime: Date.now() })
                setIsWaiting(false)
              }

              // If we have new tools, add them
              if (newTools.length > 0) {
                updateToolActivities(prev => [...prev, ...newTools])
                setIsWaiting(false)
                setIsProcessing(false)
              }

              // If we have text, create message with ALL currently tracked tools (including new ones)
              if (textContent) {
                // Capture current tools PLUS new tools from this message
                const allTools = [...toolActivitiesRef.current, ...newTools]
                setMessages(prev => [...prev, {
                  id: Date.now().toString(),
                  role: 'assistant',
                  content: textContent as string,
                  timestamp: new Date(),
                  toolsSnapshot: allTools.length > 0 ? allTools : undefined
                }])
                // Clear tools after attaching to message
                updateToolActivities(() => [])
                setIsWaiting(false)
                setIsProcessing(false)
                setThinking(null)
              }
            }
          }

          // Handle user messages (tool results) - mark tool as complete
          else if (m.type === 'user') {
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

          else if (m.type === 'result') {
            // Final result - clear all activity states
            setIsWaiting(false)
            setIsProcessing(false)
            setThinking(prev => prev ? { ...prev, isActive: false, isExpanded: false } : null)
          }
        }
        break

      case 'claude:exit':
        setThinking(null)
        updateToolActivities(() => [])
        setIsWaiting(false)
        break

      case 'claude:error':
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
          role: 'assistant',
          content: `Error: ${msg.message}`,
          timestamp: new Date()
        }])
        setThinking(null)
        updateToolActivities(() => [])
        setIsWaiting(false)
        break

      case 'claude:spawned':
        break

      case 'claude:compacted':
        // Show compaction notice briefly
        setCompactionNotice({
          trigger: msg.trigger as string || 'auto',
          preTokens: msg.preTokens as number || 0
        })
        // Auto-dismiss after 5 seconds
        setTimeout(() => setCompactionNotice(null), 5000)
        break
    }
  }, [])

  const sendMessage = useCallback((e?: React.FormEvent) => {
    e?.preventDefault()
    const text = input.trim()
    if (!text || !connected) return

    setMessages(prev => [...prev, {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: new Date()
    }])
    setIsWaiting(true)
    setThinking(null)
    updateToolActivities(() => []) // Clear previous turn's tools on new message

    send({ type: 'claude:input', text })
    setInput('')
  }, [input, connected, send])

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
    const hasActiveWork = thinking?.isActive || toolActivities.some(t => t.isActive) || isWaiting || isProcessing
    if (!hasActiveWork) return
    const interval = setInterval(() => setTick(n => n + 1), 100)
    return () => clearInterval(interval)
  }, [thinking?.isActive, toolActivities, isWaiting, isProcessing])

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
        {messages.length === 0 && !isWaiting && !thinking ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-600/20 flex items-center justify-center mb-4 border border-white/5">
              <Bot size={28} className="text-indigo-400" />
            </div>
            <p className="text-zinc-400 text-sm">
              {connected ? 'Send a message to start...' : 'Connecting...'}
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
                        : "bg-zinc-800/60 text-zinc-200 border border-white/5 prose prose-invert prose-sm max-w-full prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-code:text-cyan-400 prose-code:bg-zinc-900 prose-code:px-1 prose-code:rounded prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-white/10 prose-pre:overflow-x-auto prose-table:border-collapse prose-th:border prose-th:border-zinc-700 prose-th:bg-zinc-900 prose-th:px-2 prose-th:py-1 prose-td:border prose-td:border-zinc-700 prose-td:px-2 prose-td:py-1 break-words"
                    )}>
                      {msg.role === 'user' ? (
                        stripContextPrefix(msg.content)
                      ) : (
                        <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
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

            {/* Waiting indicator (before any activity) */}
            {isWaiting && !thinking && toolActivities.length === 0 && (
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
        <form onSubmit={sendMessage} className="flex items-center gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendMessage()
              }
            }}
            placeholder="Ask Claude..."
            disabled={!connected || isWaiting}
            className="flex-1 bg-zinc-950 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500/50 resize-none min-h-[40px] max-h-[120px] font-mono disabled:opacity-50"
            rows={1}
          />
          <button
            type="submit"
            className={cn(
              "p-2 rounded transition-colors self-end mb-1",
              input.trim() && connected && !isWaiting
                ? "bg-blue-600 hover:bg-blue-500 text-white"
                : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
            )}
            disabled={!input.trim() || !connected || isWaiting}
          >
            <Send size={14} />
          </button>
        </form>
        <div className="mt-1.5 flex items-center justify-between text-[9px] text-zinc-500 px-1">
          <span><kbd className="bg-zinc-800 px-1 rounded">Enter</kbd> send</span>
          <span className={cn(
            "font-medium",
            claudeRunning ? "text-green-500/60" : "text-zinc-600"
          )}>
            {claudeRunning ? 'READY' : 'IDLE'}
          </span>
        </div>
      </div>
    </div>
  )
}
