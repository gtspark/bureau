import { useEffect, useState } from 'react'
import { X, AlertCircle, CheckCircle, Info, AlertTriangle } from 'lucide-react'
import { cn } from '../lib/cn'

export type ToastType = 'error' | 'success' | 'info' | 'warning'

export interface Toast {
  id: string
  type: ToastType
  message: string
  duration?: number
}

interface ToastItemProps {
  toast: Toast
  onDismiss: (id: string) => void
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const [isExiting, setIsExiting] = useState(false)

  useEffect(() => {
    if (toast.duration !== 0) {
      const timer = setTimeout(() => {
        setIsExiting(true)
        setTimeout(() => onDismiss(toast.id), 200)
      }, toast.duration || 5000)
      return () => clearTimeout(timer)
    }
  }, [toast.id, toast.duration, onDismiss])

  const handleDismiss = () => {
    setIsExiting(true)
    setTimeout(() => onDismiss(toast.id), 200)
  }

  const icons = {
    error: <AlertCircle size={16} />,
    success: <CheckCircle size={16} />,
    info: <Info size={16} />,
    warning: <AlertTriangle size={16} />,
  }

  const styles = {
    error: 'bg-red-950/90 border-red-500/50 text-red-200',
    success: 'bg-emerald-950/90 border-emerald-500/50 text-emerald-200',
    info: 'bg-blue-950/90 border-blue-500/50 text-blue-200',
    warning: 'bg-amber-950/90 border-amber-500/50 text-amber-200',
  }

  const iconStyles = {
    error: 'text-red-400',
    success: 'text-emerald-400',
    info: 'text-blue-400',
    warning: 'text-amber-400',
  }

  return (
    <div
      className={cn(
        'flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg backdrop-blur-sm',
        'transform transition-all duration-200',
        isExiting ? 'opacity-0 translate-x-4' : 'opacity-100 translate-x-0',
        styles[toast.type]
      )}
    >
      <span className={cn('mt-0.5', iconStyles[toast.type])}>
        {icons[toast.type]}
      </span>
      <p className="flex-1 text-sm">{toast.message}</p>
      <button
        onClick={handleDismiss}
        className="text-current opacity-60 hover:opacity-100 transition-opacity"
      >
        <X size={14} />
      </button>
    </div>
  )
}

interface ToastContainerProps {
  toasts: Toast[]
  onDismiss: (id: string) => void
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map(toast => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  )
}
