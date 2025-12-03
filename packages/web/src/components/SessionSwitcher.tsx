import { useState, useRef, useEffect } from 'react'
import { useSession } from '../contexts/SessionContext'
import { ChevronDown, Trash2, Edit2, Check, X, FolderOpen } from 'lucide-react'
import { cn } from '../lib/cn'
import { ConfirmModal } from './ConfirmModal'

export function SessionSwitcher() {
  const { activeSession, sessions, switchSession, renameSession, deleteSession } = useSession()
  const [isOpen, setIsOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
        setEditingId(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleRename = (id: string) => {
    if (editName.trim()) {
      renameSession(id, editName.trim())
      setEditingId(null)
    }
  }

  const handleDelete = (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setDeleteConfirm({ id, name })
  }

  const confirmDelete = () => {
    if (deleteConfirm) {
      deleteSession(deleteConfirm.id)
      setDeleteConfirm(null)
    }
  }

  const startEdit = (id: string, currentName: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingId(id)
    setEditName(currentName)
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString()
  }

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-zinc-300 hover:text-white bg-zinc-800/50 hover:bg-zinc-700/50 border border-white/5 rounded-md transition-colors"
      >
        <FolderOpen size={12} className="text-blue-400" />
        <span className="max-w-[120px] truncate">{activeSession?.name || 'No Session'}</span>
        <ChevronDown size={12} className={cn("transition-transform", isOpen && "rotate-180")} />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-zinc-900 border border-white/10 rounded-lg shadow-xl z-50 overflow-hidden">
          {/* Header */}
          <div className="px-3 py-2 border-b border-white/5">
            <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Sessions</span>
          </div>

          {/* Session list */}
          <div className="max-h-64 overflow-y-auto custom-scrollbar">
            {sessions.length === 0 ? (
              <div className="px-3 py-4 text-center text-zinc-500 text-xs">
                No sessions yet
              </div>
            ) : (
              sessions.map((session) => (
                <div
                  key={session.id}
                  onClick={() => {
                    if (editingId !== session.id) {
                      switchSession(session.id)
                      setIsOpen(false)
                    }
                  }}
                  className={cn(
                    "px-3 py-2 flex items-center gap-2 cursor-pointer transition-colors group",
                    session.id === activeSession?.id
                      ? "bg-blue-500/10 border-l-2 border-blue-500"
                      : "hover:bg-white/5 border-l-2 border-transparent"
                  )}
                >
                  {editingId === session.id ? (
                    <div className="flex-1 flex items-center gap-2">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRename(session.id)
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        className="flex-1 bg-zinc-800 border border-white/10 rounded px-2 py-0.5 text-xs text-white focus:outline-none focus:border-blue-500/50"
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                      />
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRename(session.id) }}
                        className="p-1 text-green-400 hover:bg-green-500/10 rounded"
                      >
                        <Check size={12} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditingId(null) }}
                        className="p-1 text-zinc-400 hover:bg-white/5 rounded"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-zinc-200 truncate">
                            {session.name}
                          </span>
                          <span className={cn(
                            "w-1.5 h-1.5 rounded-full shrink-0",
                            session.status === 'running' ? "bg-green-400" :
                            session.status === 'error' ? "bg-red-400" :
                            "bg-zinc-500"
                          )} />
                        </div>
                        <div className="text-[10px] text-zinc-500 truncate">
                          {formatDate(session.lastActiveAt)}
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => startEdit(session.id, session.name, e)}
                          className="p-1 text-zinc-400 hover:text-white hover:bg-white/10 rounded transition-colors"
                        >
                          <Edit2 size={12} />
                        </button>
                        <button
                          onClick={(e) => handleDelete(session.id, session.name, e)}
                          className="p-1 text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <ConfirmModal
          title="Delete Session"
          message={
            <>
              Delete <span className="text-blue-400 font-medium">{deleteConfirm.name}</span>? Chat history will be lost.
            </>
          }
          confirmLabel="Delete"
          onConfirm={confirmDelete}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  )
}
