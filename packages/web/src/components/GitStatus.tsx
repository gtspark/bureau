import { useEffect, useState, useCallback } from 'react'
import { useWebSocket, useWebSocketMessages } from '../contexts/WebSocketContext'
import { Plus, Minus, Check, RefreshCw, AlertCircle, Loader2, ChevronDown, ChevronRight, ArrowUp, ArrowDown } from 'lucide-react'
import { cn } from '../lib/cn'

interface GitStatusData {
  isRepo: boolean
  branch: string
  staged: string[]
  unstaged: string[]
  untracked: string[]
  ahead: number
  behind: number
}

function FileStatusIcon({ type }: { type: 'staged' | 'unstaged' | 'untracked' }) {
  switch (type) {
    case 'staged':
      return <span className="w-4 h-4 flex items-center justify-center text-[10px] font-bold text-green-400 bg-green-500/20 rounded">S</span>
    case 'unstaged':
      return <span className="w-4 h-4 flex items-center justify-center text-[10px] font-bold text-yellow-400 bg-yellow-500/20 rounded">M</span>
    case 'untracked':
      return <span className="w-4 h-4 flex items-center justify-center text-[10px] font-bold text-zinc-400 bg-zinc-500/20 rounded">U</span>
  }
}

export function GitStatus() {
  const { connected, send } = useWebSocket()
  const [status, setStatus] = useState<GitStatusData | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [isCommitting, setIsCommitting] = useState(false)
  const [isPushing, setIsPushing] = useState(false)
  const [isPulling, setIsPulling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stagedOpen, setStagedOpen] = useState(true)
  const [changesOpen, setChangesOpen] = useState(true)
  const [untrackedOpen, setUntrackedOpen] = useState(true)
  const [justCommitted, setJustCommitted] = useState(false)

  // Request git status
  const refreshStatus = useCallback(() => {
    send({ type: 'git:status' })
  }, [send])

  // Stage a file
  const stageFile = useCallback((path: string) => {
    send({ type: 'git:stage', paths: [path] })
  }, [send])

  // Unstage a file
  const unstageFile = useCallback((path: string) => {
    send({ type: 'git:unstage', paths: [path] })
  }, [send])

  // Commit staged changes
  const commit = useCallback(() => {
    if (!commitMessage.trim()) {
      setError('Commit message is required')
      return
    }
    setIsCommitting(true)
    setError(null)
    send({ type: 'git:commit', message: commitMessage })
  }, [send, commitMessage])

  // Push to remote
  const push = useCallback(() => {
    setIsPushing(true)
    setError(null)
    send({ type: 'git:push' })
  }, [send])

  // Pull from remote
  const pull = useCallback(() => {
    setIsPulling(true)
    setError(null)
    send({ type: 'git:pull' })
  }, [send])

  // Request initial status and poll
  useEffect(() => {
    if (!connected) return

    // Request initial status
    refreshStatus()

    // Poll every 5 seconds
    const pollInterval = setInterval(refreshStatus, 5000)

    return () => clearInterval(pollInterval)
  }, [connected, refreshStatus])

  // Subscribe to messages
  useWebSocketMessages((msg) => {
    switch (msg.type) {
      case 'git:status':
        setStatus(msg.status as GitStatusData)
        break

      case 'git:staged':
      case 'git:unstaged':
        setStatus(msg.status as GitStatusData)
        break

      case 'git:committed':
        setStatus(msg.status as GitStatusData)
        setCommitMessage('')
        setIsCommitting(false)
        setJustCommitted(true)
        break

      case 'git:pushed':
        setStatus(msg.status as GitStatusData)
        setIsPushing(false)
        setJustCommitted(false)
        break

      case 'git:pulled':
        setStatus(msg.status as GitStatusData)
        setIsPulling(false)
        break

      case 'file:changed':
        // Refresh status on file changes
        refreshStatus()
        break

      case 'explorer:cwd':
        // CWD changed, refresh git status for new directory
        setStatus(null) // Show loading while fetching
        refreshStatus()
        break

      case 'error':
        if ((msg.originalType as string)?.startsWith('git:')) {
          setError(msg.message as string)
          setIsCommitting(false)
          setIsPushing(false)
          setIsPulling(false)
        }
        break
    }
  }, [refreshStatus])

  if (!connected) {
    return (
      <div className="p-4 flex items-center gap-2 text-zinc-500 text-sm">
        <Loader2 size={14} className="animate-spin" />
        <span>Connecting...</span>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="p-4 flex items-center gap-2 text-zinc-500 text-sm">
        <Loader2 size={14} className="animate-spin" />
        <span>Loading...</span>
      </div>
    )
  }

  if (!status.isRepo) {
    return (
      <div className="p-6 text-center">
        <div className="text-zinc-600 text-sm italic">Not a git repository</div>
        <p className="text-zinc-700 text-xs mt-2">Initialize a git repo to use source control</p>
      </div>
    )
  }

  const hasChanges = status.staged.length > 0 || status.unstaged.length > 0 || status.untracked.length > 0

  return (
    <div className="flex flex-col h-full text-sm">
      {/* Branch info */}
      <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2 bg-zinc-900/30">
        <div className="flex items-center gap-2 flex-1">
          <span className="text-zinc-500 text-xs">Branch:</span>
          <span className="text-blue-400 font-medium">{status.branch}</span>
          {status.ahead > 0 && (
            <button
              onClick={push}
              disabled={isPushing}
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-1 transition-colors",
                isPushing
                  ? "bg-green-500/10 text-green-400/50 cursor-not-allowed"
                  : "bg-green-500/20 text-green-400 hover:bg-green-500/30"
              )}
              title="Push to remote"
            >
              {isPushing ? <Loader2 size={10} className="animate-spin" /> : <ArrowUp size={10} />}
              {status.ahead}
            </button>
          )}
          {status.behind > 0 && (
            <button
              onClick={pull}
              disabled={isPulling}
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-1 transition-colors",
                isPulling
                  ? "bg-blue-500/10 text-blue-400/50 cursor-not-allowed"
                  : "bg-blue-500/20 text-blue-400 hover:bg-blue-500/30"
              )}
              title="Pull from remote"
            >
              {isPulling ? <Loader2 size={10} className="animate-spin" /> : <ArrowDown size={10} />}
              {status.behind}
            </button>
          )}
        </div>
        <button
          onClick={refreshStatus}
          className="p-1.5 hover:bg-white/5 rounded-lg text-zinc-500 hover:text-zinc-300 transition-colors"
          title="Refresh"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Error message */}
      {error && (
        <div className="mx-3 mt-3 p-2.5 bg-red-900/30 border border-red-500/30 rounded-lg text-red-300 text-xs flex items-start gap-2">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-200 p-0.5"
          >
            &times;
          </button>
        </div>
      )}

      {/* File lists */}
      <div className="flex-1 overflow-auto custom-scrollbar py-2">
        {!hasChanges && (
          <div className="p-6 text-center">
            <Check size={24} className="mx-auto text-green-500 mb-2" />
            <div className="text-zinc-500 text-sm">No changes</div>
            <p className="text-zinc-600 text-xs mt-1">Working tree is clean</p>
          </div>
        )}

        {/* Staged files */}
        {status.staged.length > 0 && (
          <div className="mb-1">
            <button
              onClick={() => setStagedOpen(!stagedOpen)}
              className="w-full px-3 py-1.5 text-[10px] font-bold text-green-400/80 tracking-wider flex items-center gap-1 hover:bg-white/5 transition-colors"
            >
              {stagedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              STAGED CHANGES
              <span className="ml-auto text-green-400 bg-green-500/20 px-1.5 py-0.5 rounded-full">
                {status.staged.length}
              </span>
            </button>
            {stagedOpen && (
              <div className="animate-fade-in">
                {status.staged.map(file => (
                  <div
                    key={file}
                    className="px-3 py-1 flex items-center gap-2 hover:bg-white/5 cursor-pointer group transition-colors"
                    onClick={() => unstageFile(file)}
                    title="Click to unstage"
                  >
                    <FileStatusIcon type="staged" />
                    <span className="truncate text-zinc-300 flex-1">{file}</span>
                    <button className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-500/20 rounded text-red-400 transition-all">
                      <Minus size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Unstaged changes */}
        {status.unstaged.length > 0 && (
          <div className="mb-1">
            <button
              onClick={() => setChangesOpen(!changesOpen)}
              className="w-full px-3 py-1.5 text-[10px] font-bold text-yellow-400/80 tracking-wider flex items-center gap-1 hover:bg-white/5 transition-colors"
            >
              {changesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              CHANGES
              <span className="ml-auto text-yellow-400 bg-yellow-500/20 px-1.5 py-0.5 rounded-full">
                {status.unstaged.length}
              </span>
            </button>
            {changesOpen && (
              <div className="animate-fade-in">
                {status.unstaged.map(file => (
                  <div
                    key={file}
                    className="px-3 py-1 flex items-center gap-2 hover:bg-white/5 cursor-pointer group transition-colors"
                    onClick={() => stageFile(file)}
                    title="Click to stage"
                  >
                    <FileStatusIcon type="unstaged" />
                    <span className="truncate text-zinc-300 flex-1">{file}</span>
                    <button className="opacity-0 group-hover:opacity-100 p-1 hover:bg-green-500/20 rounded text-green-400 transition-all">
                      <Plus size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Untracked files */}
        {status.untracked.length > 0 && (
          <div className="mb-1">
            <button
              onClick={() => setUntrackedOpen(!untrackedOpen)}
              className="w-full px-3 py-1.5 text-[10px] font-bold text-zinc-500 tracking-wider flex items-center gap-1 hover:bg-white/5 transition-colors"
            >
              {untrackedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              UNTRACKED
              <span className="ml-auto text-zinc-400 bg-zinc-500/20 px-1.5 py-0.5 rounded-full">
                {status.untracked.length}
              </span>
            </button>
            {untrackedOpen && (
              <div className="animate-fade-in">
                {status.untracked.map(file => (
                  <div
                    key={file}
                    className="px-3 py-1 flex items-center gap-2 hover:bg-white/5 cursor-pointer group transition-colors"
                    onClick={() => stageFile(file)}
                    title="Click to stage"
                  >
                    <FileStatusIcon type="untracked" />
                    <span className="truncate text-zinc-400 flex-1">{file}</span>
                    <button className="opacity-0 group-hover:opacity-100 p-1 hover:bg-green-500/20 rounded text-green-400 transition-all">
                      <Plus size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Commit section */}
      {status.staged.length > 0 && (
        <div className="p-3 border-t border-white/5 bg-zinc-900/30">
          <input
            type="text"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                commit()
              }
            }}
            placeholder="Commit message..."
            className="w-full bg-zinc-950 text-zinc-100 px-3 py-2 rounded-lg text-sm border border-white/10 focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 focus:outline-none mb-2 placeholder:text-zinc-600 transition-all"
            disabled={isCommitting}
          />
          <button
            onClick={commit}
            disabled={isCommitting || !commitMessage.trim()}
            className={cn(
              "w-full py-2 px-3 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2",
              isCommitting || !commitMessage.trim()
                ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                : "bg-green-600 hover:bg-green-500 text-white shadow-lg shadow-green-500/20"
            )}
          >
            {isCommitting ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Committing...
              </>
            ) : (
              <>
                <Check size={14} />
                Commit {status.staged.length} file{status.staged.length === 1 ? '' : 's'}
              </>
            )}
          </button>
        </div>
      )}

      {/* Push section - shows after commit or when ahead */}
      {status.staged.length === 0 && (justCommitted || status.ahead > 0) && (
        <div className="p-3 border-t border-white/5 bg-zinc-900/30">
          <button
            onClick={push}
            disabled={isPushing}
            className={cn(
              "w-full py-2 px-3 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2",
              isPushing
                ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                : "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20"
            )}
          >
            {isPushing ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Pushing...
              </>
            ) : (
              <>
                <ArrowUp size={14} />
                Push {status.ahead > 0 ? `${status.ahead} commit${status.ahead === 1 ? '' : 's'}` : 'to remote'}
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )
}
