import { useState, useEffect, useRef } from 'react'
import { X, FolderOpen } from 'lucide-react'
import { useSession } from '../contexts/SessionContext'
import { useWebSocket, useWebSocketMessages } from '../contexts/WebSocketContext'
import { Session } from '../types/session'

interface NewSessionModalProps {
  isOpen: boolean
  onClose: () => void
}

export function NewSessionModal({ isOpen, onClose }: NewSessionModalProps) {
  const { createSession, switchSession, activeSession } = useSession()
  const { claudeCwd } = useWebSocket()
  const [name, setName] = useState('')
  const [projectRoot, setProjectRoot] = useState('')
  const [pendingSessionName, setPendingSessionName] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  // Listen for session creation to auto-switch
  useWebSocketMessages((msg) => {
    if (msg.type === 'sessions:created' && pendingSessionName) {
      const session = msg.session as Session
      if (session.name === pendingSessionName) {
        switchSession(session.id)
        setPendingSessionName(null)
      }
    }
  }, [pendingSessionName, switchSession])

  // Set default projectRoot when modal opens
  useEffect(() => {
    if (isOpen) {
      setName('')
      setProjectRoot(claudeCwd || activeSession?.projectRoot || '/var/www/html')
      setPendingSessionName(null)
      // Focus name input after a brief delay
      setTimeout(() => nameInputRef.current?.focus(), 50)
    }
  }, [isOpen, claudeCwd, activeSession])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (name.trim() && projectRoot.trim()) {
      setPendingSessionName(name.trim())
      createSession(name.trim(), projectRoot.trim())
      onClose()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
    }
  }

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={handleKeyDown}
    >
      <div className="bg-zinc-900 border border-white/10 rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/10 rounded-lg">
              <FolderOpen size={18} className="text-blue-400" />
            </div>
            <h2 className="text-base font-semibold text-white">New Session</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="space-y-2">
            <label className="block text-xs font-medium text-zinc-400 uppercase tracking-wider">
              Session Name
            </label>
            <input
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-colors"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-medium text-zinc-400 uppercase tracking-wider">
              Project Path
            </label>
            <input
              type="text"
              value={projectRoot}
              onChange={(e) => setProjectRoot(e.target.value)}
              placeholder="/path/to/project"
              className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white font-mono placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-colors"
            />
            <p className="text-[11px] text-zinc-500">
              Claude will start in this directory
            </p>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || !projectRoot.trim()}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-400 disabled:cursor-not-allowed rounded-lg transition-colors"
            >
              Create Session
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
