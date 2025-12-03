import { useState, useCallback, useEffect, useRef, cloneElement, isValidElement, ReactNode, ReactElement } from 'react'
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  ImperativePanelHandle,
} from 'react-resizable-panels'
import { Header } from './Header'
import { GitBranch, AlertCircle, CheckCircle2, XCircle } from 'lucide-react'
import { useWebSocket, useWebSocketMessages } from '../contexts/WebSocketContext'

interface LayoutProps {
  sidebar: ReactNode
  editor: ReactNode
  chat: ReactNode
  terminal: ReactNode
  claudeStatus?: 'connected' | 'disconnected' | 'running'
}

interface TerminalChildProps {
  isMaximized?: boolean
  onMaximize?: () => void
  onClose?: () => void
}

interface GitStatus {
  branch: string
  files: Array<{ path: string; status: string; staged: boolean }>
}

// Horizontal resize handle
function Handle() {
  return (
    <PanelResizeHandle className="w-1 bg-transparent hover:bg-blue-500/10 transition-colors flex items-center justify-center group focus:outline-none">
      <div className="w-[1px] h-full bg-white/5 group-hover:bg-blue-500/50 group-hover:shadow-[0_0_8px_rgba(59,130,246,0.6)] transition-all duration-300" />
    </PanelResizeHandle>
  )
}

// Vertical resize handle
function VerticalHandle() {
  return (
    <PanelResizeHandle className="h-1 bg-transparent hover:bg-blue-500/10 transition-colors flex items-center justify-center group focus:outline-none cursor-row-resize z-10">
      <div className="h-[1px] w-full bg-white/5 group-hover:bg-blue-500/50 group-hover:shadow-[0_0_8px_rgba(59,130,246,0.6)] transition-all duration-300" />
    </PanelResizeHandle>
  )
}

export function Layout({
  sidebar,
  editor,
  chat,
  terminal,
  claudeStatus = 'disconnected',
}: LayoutProps) {
  const { connected, send } = useWebSocket()
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [chatVisible, setChatVisible] = useState(true)
  const [terminalMaximized, setTerminalMaximized] = useState(false)
  const [gitBranch, setGitBranch] = useState<string>('main')
  const [errorCount, _setErrorCount] = useState(0)
  const [warningCount, _setWarningCount] = useState(0)

  const terminalPanelRef = useRef<ImperativePanelHandle>(null)
  const editorPanelRef = useRef<ImperativePanelHandle>(null)

  const toggleSidebar = useCallback(() => {
    setSidebarVisible(prev => !prev)
  }, [])

  const toggleChat = useCallback(() => {
    setChatVisible(prev => !prev)
  }, [])

  const toggleTerminalMaximize = useCallback(() => {
    setTerminalMaximized(prev => {
      const next = !prev
      if (next) {
        // Maximize terminal to ~60%
        terminalPanelRef.current?.resize(60)
        editorPanelRef.current?.resize(40)
      } else {
        // Restore to default ~30%
        terminalPanelRef.current?.resize(30)
        editorPanelRef.current?.resize(70)
      }
      return next
    })
  }, [])

  const closeTerminal = useCallback(() => {
    terminalPanelRef.current?.collapse()
  }, [])

  // Fetch git status on connect
  useEffect(() => {
    if (connected) {
      send({ type: 'git:status' })
    }
  }, [connected, send])

  // Listen for git status updates
  useWebSocketMessages((msg) => {
    if (msg.type === 'git:status' && msg.status) {
      const status = msg.status as GitStatus
      if (status.branch) {
        setGitBranch(status.branch)
      }
    }
  }, [])

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-zinc-950 text-ide-text font-sans antialiased selection:bg-blue-500/30 selection:text-blue-100">
      <Header
        claudeStatus={claudeStatus}
        onToggleSidebar={toggleSidebar}
        onToggleChat={toggleChat}
      />

      <div className="flex-1 overflow-hidden relative z-0">
        {/* Subtle background glow for depth */}
        <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_top_right,_var(--tw-gradient-stops))] from-blue-900/10 via-transparent to-transparent pointer-events-none z-[-1]" />

        <PanelGroup direction="horizontal" autoSaveId="bureau-ide-layout">
          {/* Sidebar */}
          {sidebarVisible && (
            <>
              <Panel defaultSize={20} minSize={15} maxSize={30} collapsible className="bg-zinc-900/50 backdrop-blur-sm border-r border-white/5">
                {sidebar}
              </Panel>
              <Handle />
            </>
          )}

          {/* Main Content Area */}
          <Panel className="bg-zinc-950/80">
            <PanelGroup direction="vertical" autoSaveId="bureau-ide-center">
              {/* Editor */}
              <Panel ref={editorPanelRef} defaultSize={70} minSize={30}>
                {editor}
              </Panel>

              <VerticalHandle />

              {/* Terminal */}
              <Panel ref={terminalPanelRef} defaultSize={30} minSize={10} collapsible className="bg-[#0c0c0e] border-t border-white/5">
                {isValidElement(terminal)
                  ? cloneElement(terminal as ReactElement<TerminalChildProps>, {
                      isMaximized: terminalMaximized,
                      onMaximize: toggleTerminalMaximize,
                      onClose: closeTerminal,
                    })
                  : terminal}
              </Panel>
            </PanelGroup>
          </Panel>

          {/* Chat Panel */}
          {chatVisible && (
            <>
              <Handle />
              <Panel defaultSize={25} minSize={20} maxSize={40} collapsible className="bg-zinc-900/80 backdrop-blur-md border-l border-white/5 shadow-2xl">
                {isValidElement(chat)
                  ? cloneElement(chat as ReactElement<{ onClose?: () => void }>, { onClose: toggleChat })
                  : chat}
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>

      {/* Footer Status Bar */}
      <footer className="h-6 bg-gradient-to-r from-blue-700 to-blue-600 text-white/90 flex items-center justify-between px-3 text-[10px] font-medium tracking-wide select-none shadow-lg z-20">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 hover:bg-white/10 px-2 py-0.5 rounded cursor-pointer transition-colors">
            <GitBranch size={10} />
            <span>{gitBranch}</span>
          </div>
          <div className="flex items-center gap-3 hover:bg-white/10 px-2 py-0.5 rounded cursor-pointer transition-colors">
            <div className="flex items-center gap-1">
              <XCircle size={10} /> {errorCount}
            </div>
            <div className="flex items-center gap-1">
              <AlertCircle size={10} /> {warningCount}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1 hover:bg-white/10 px-2 py-0.5 rounded cursor-pointer transition-colors">
            <span>UTF-8</span>
          </div>
          <div className="flex items-center gap-1 hover:bg-white/10 px-2 py-0.5 rounded cursor-pointer transition-colors">
            <CheckCircle2 size={10} />
            <span>Claude Max</span>
          </div>
          <div className="hover:bg-white/10 px-2 py-0.5 rounded cursor-pointer transition-colors">
            <span className="w-2 h-2 rounded-full bg-blue-400 block shadow-[0_0_8px_rgba(96,165,250,0.8)]" />
          </div>
        </div>
      </footer>
    </div>
  )
}
