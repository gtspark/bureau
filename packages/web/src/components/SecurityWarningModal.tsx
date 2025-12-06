import { useState, useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'

const STORAGE_KEY = 'bureau-security-warning-acknowledged'

export function SecurityWarningModal() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    // Check if user has already acknowledged
    const acknowledged = localStorage.getItem(STORAGE_KEY)
    if (!acknowledged) {
      setShow(true)
    }
  }, [])

  const handleAcknowledge = () => {
    localStorage.setItem(STORAGE_KEY, 'true')
    setShow(false)
  }

  if (!show) return null

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-zinc-900 border border-amber-500/30 rounded-xl max-w-lg w-full shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 p-4 border-b border-amber-500/20 bg-amber-500/5">
          <div className="w-10 h-10 rounded-lg bg-amber-500/20 flex items-center justify-center">
            <AlertTriangle size={24} className="text-amber-400" />
          </div>
          <div>
            <h2 className="text-amber-200 font-semibold">Security Notice</h2>
            <p className="text-amber-200/60 text-xs">Please read before continuing</p>
          </div>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4 text-sm">
          <p className="text-zinc-300">
            Bureau runs Claude Code with <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-amber-300 text-xs">--dangerously-skip-permissions</code>
          </p>

          <p className="text-zinc-400">
            This means <strong className="text-zinc-200">all file operations, shell commands, and code execution are automatically approved</strong> without confirmation.
          </p>

          <p className="text-zinc-400">
            This is intentional — a web UI cannot handle interactive permission prompts. Claude will be able to read, write, and execute anything within the project root.
          </p>

          <div className="bg-amber-950/30 border border-amber-500/20 rounded-lg p-3">
            <p className="text-amber-200/80 text-xs">
              Only use Bureau on machines and projects where you trust Claude to make changes without confirmation. Do not expose Bureau to the public internet.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-white/5 bg-zinc-900/50">
          <button
            onClick={handleAcknowledge}
            className="w-full py-2.5 px-4 bg-amber-600 hover:bg-amber-500 text-white font-medium rounded-lg transition-colors"
          >
            I understand, continue
          </button>
        </div>
      </div>
    </div>
  )
}
