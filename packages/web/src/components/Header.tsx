import { useState, useRef, useEffect } from 'react'
import { Command, Search, PanelLeft, LayoutGrid, Sidebar, Bell, Settings } from 'lucide-react'
import { NewSessionModal } from './NewSessionModal'
import { cn } from '../lib/cn'

interface HeaderProps {
  claudeStatus?: 'connected' | 'disconnected' | 'running'
  onToggleSidebar?: () => void
  onToggleChat?: () => void
}

interface MenuItem {
  label: string
  shortcut?: string
  action?: () => void
  divider?: boolean
}

function MenuDropdown({ label, items, isOpen, onToggle, onClose }: {
  label: string
  items: MenuItem[]
  isOpen: boolean
  onToggle: () => void
  onClose: () => void
}) {
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        onClose()
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen, onClose])

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={onToggle}
        className={cn(
          "px-2 py-1 rounded-md transition-all duration-200",
          isOpen
            ? "text-zinc-100 bg-white/10"
            : "hover:text-zinc-100 hover:bg-white/5"
        )}
      >
        {label}
      </button>
      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-zinc-900 border border-white/10 rounded-lg shadow-xl z-50 py-1 overflow-hidden">
          {items.map((item, index) => (
            item.divider ? (
              <div key={index} className="my-1 border-t border-white/5" />
            ) : (
              <button
                key={index}
                onClick={() => {
                  item.action?.()
                  onClose()
                }}
                className="w-full px-3 py-1.5 flex items-center justify-between text-left text-sm text-zinc-300 hover:text-white hover:bg-white/5 transition-colors"
              >
                <span>{item.label}</span>
                {item.shortcut && (
                  <span className="text-[10px] text-zinc-500">{item.shortcut}</span>
                )}
              </button>
            )
          ))}
        </div>
      )}
    </div>
  )
}

export function Header({ claudeStatus = 'disconnected', onToggleSidebar, onToggleChat }: HeaderProps) {
  const isConnected = claudeStatus === 'connected' || claudeStatus === 'running'
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [showNewSessionModal, setShowNewSessionModal] = useState(false)

  const fileMenuItems: MenuItem[] = [
    { label: 'New Session', shortcut: 'Ctrl+Shift+N', action: () => setShowNewSessionModal(true) },
  ]

  const menuItems: Record<string, MenuItem[]> = {
    File: fileMenuItems,
  }

  return (
    <>
      <header className="h-10 border-b border-white/5 bg-zinc-900/80 backdrop-blur-md flex items-center justify-between px-3 select-none z-50 relative">
        {/* Left Section: Logo & Controls */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 group cursor-pointer">
            <div className="bg-gradient-to-tr from-blue-600 to-cyan-500 p-1 rounded-lg shadow-lg shadow-blue-500/20 group-hover:shadow-blue-500/40 transition-all duration-300">
              <Command size={14} className="text-white" />
            </div>
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-gray-100 to-gray-400 font-bold tracking-tight group-hover:from-white group-hover:to-gray-300 transition-all">Bureau</span>
          </div>

          <div className="h-4 w-[1px] bg-white/10 mx-1" />

          <nav className="flex items-center gap-0.5 text-xs font-medium text-zinc-400">
            {['File', 'Edit', 'View', 'Go', 'Run', 'Terminal', 'Help'].map((item) => (
              menuItems[item] ? (
                <MenuDropdown
                  key={item}
                  label={item}
                  items={menuItems[item]}
                  isOpen={openMenu === item}
                  onToggle={() => setOpenMenu(openMenu === item ? null : item)}
                  onClose={() => setOpenMenu(null)}
                />
              ) : (
                <button key={item} className="hover:text-zinc-100 px-2 py-1 rounded-md hover:bg-white/5 transition-all duration-200">{item}</button>
              )
            ))}
          </nav>
        </div>

        {/* Center: Command Palette Trigger */}
        <div className="flex-1 max-w-lg mx-4">
          <button className="w-full flex items-center justify-between bg-black/20 border border-white/5 rounded-lg text-xs px-3 py-1.5 text-zinc-400 hover:border-white/10 hover:bg-black/40 hover:text-zinc-200 transition-all duration-200 group shadow-inner">
            <div className="flex items-center gap-2">
              <Search size={12} className="group-hover:text-blue-400 transition-colors" />
              <span className="opacity-70 group-hover:opacity-100">Search files and commands...</span>
            </div>
            <div className="flex items-center gap-1">
              <kbd className="bg-white/5 border border-white/10 rounded px-1 min-w-[20px] text-center font-mono text-[10px]">Ctrl</kbd>
              <kbd className="bg-white/5 border border-white/10 rounded px-1 min-w-[20px] text-center font-mono text-[10px]">P</kbd>
            </div>
          </button>
        </div>

        {/* Right Section: Status & Actions */}
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-2 px-2.5 py-1 rounded-full border transition-colors cursor-pointer group ${
            isConnected
              ? 'bg-green-500/5 border-green-500/10 hover:bg-green-500/10'
              : 'bg-zinc-500/5 border-zinc-500/10 hover:bg-zinc-500/10'
          }`}>
            <div className="relative w-1.5 h-1.5">
              {isConnected && <div className="absolute inset-0 bg-green-500 rounded-full animate-ping opacity-75" />}
              <div className={`relative w-1.5 h-1.5 rounded-full ${
                isConnected
                  ? 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.5)]'
                  : 'bg-zinc-500'
              }`} />
            </div>
            <span className={`text-[10px] font-medium tracking-wide transition-colors ${
              isConnected
                ? 'text-green-400 group-hover:text-green-300'
                : 'text-zinc-500 group-hover:text-zinc-400'
            }`}>
              {claudeStatus === 'running' ? 'WORKING' : isConnected ? 'CONNECTED' : 'OFFLINE'}
            </span>
          </div>

          <div className="h-4 w-[1px] bg-white/10 mx-1" />

          <div className="flex items-center gap-1">
            <button
              onClick={onToggleSidebar}
              className="text-zinc-400 hover:text-zinc-100 p-1.5 hover:bg-white/5 rounded-md transition-all"
              title="Toggle sidebar"
            >
              <PanelLeft size={16} />
            </button>
            <button className="text-zinc-400 hover:text-zinc-100 p-1.5 hover:bg-white/5 rounded-md transition-all">
              <LayoutGrid size={16} />
            </button>
            <button
              onClick={onToggleChat}
              className="text-zinc-400 hover:text-zinc-100 p-1.5 hover:bg-white/5 rounded-md transition-all"
              title="Toggle chat"
            >
              <Sidebar size={16} className="rotate-180" />
            </button>
          </div>

          <div className="h-4 w-[1px] bg-white/10 mx-1" />

          <button className="text-zinc-400 hover:text-zinc-100 p-1.5 hover:bg-white/5 rounded-md transition-all">
            <Bell size={16} />
          </button>
          <button className="text-zinc-400 hover:text-zinc-100 p-1.5 hover:bg-white/5 rounded-md transition-all">
            <Settings size={16} />
          </button>

          <div className="w-7 h-7 ml-2 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-700 shadow-lg shadow-indigo-500/20 flex items-center justify-center text-xs font-bold text-white cursor-pointer hover:shadow-indigo-500/40 hover:scale-105 transition-all duration-200 border border-white/10">
            B
          </div>
        </div>
      </header>

      <NewSessionModal
        isOpen={showNewSessionModal}
        onClose={() => setShowNewSessionModal(false)}
      />
    </>
  )
}
