import { useState, ReactNode, useCallback } from 'react'
import { Files, GitBranch, Search, Settings, Box, RefreshCw, ChevronUp, ChevronRight } from 'lucide-react'
import { cn } from '../lib/cn'

type SidebarView = 'explorer' | 'search' | 'git' | 'extensions'

interface SidebarProps {
  fileTree: ReactNode
  gitStatus: ReactNode
  claudeCwd: string | null
  explorerBasePath: string
  projectRoot: string
  onExplorerSync: () => void
  onPathChange: (path: string) => void
  onRefresh: () => void
}

interface ActivityIconProps {
  icon: ReactNode
  active: boolean
  onClick: () => void
  badge?: number
}

function ActivityIcon({ icon, active, onClick, badge }: ActivityIconProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative w-9 h-9 flex items-center justify-center rounded-xl transition-all duration-300 group",
        active
          ? "text-blue-400 bg-blue-500/10 shadow-[0_0_15px_rgba(59,130,246,0.2)]"
          : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
      )}
    >
      {active && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 -ml-[1px] h-4 w-1 bg-blue-500 rounded-r-full shadow-[0_0_8px_rgba(59,130,246,0.8)]" />
      )}

      <span className="relative z-10 transition-transform duration-300 group-hover:scale-110">
        {icon}
      </span>

      {badge !== undefined && badge > 0 && (
        <span className="absolute -top-1 -right-1 h-3.5 min-w-[14px] px-1 flex items-center justify-center text-[9px] font-bold text-white bg-blue-600 rounded-full border border-zinc-900 shadow-md">
          {badge}
        </span>
      )}
    </button>
  )
}

export function Sidebar({ fileTree, gitStatus, claudeCwd, explorerBasePath, projectRoot, onExplorerSync, onPathChange, onRefresh }: SidebarProps) {
  const [activeView, setActiveView] = useState<SidebarView>('explorer')
  const [isRefreshing, setIsRefreshing] = useState(false)

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true)
    onRefresh()
    // Reset after animation completes
    setTimeout(() => setIsRefreshing(false), 500)
  }, [onRefresh])

  // Check if sync is available (cwd differs from current base path AND is within projectRoot)
  const cwdInProject = claudeCwd && (claudeCwd === projectRoot || claudeCwd.startsWith(projectRoot + '/'))
  const syncAvailable = cwdInProject && claudeCwd !== explorerBasePath

  // Get project folder name (basename of projectRoot)
  const projectName = projectRoot.split('/').filter(Boolean).pop() || 'Project'

  // Get path relative to projectRoot
  const getRelativePath = (path: string): string => {
    if (path === projectRoot) return ''
    if (path.startsWith(projectRoot + '/')) {
      return path.slice(projectRoot.length + 1)
    }
    return ''
  }

  // Parse relative path into segments for breadcrumb
  const relativePath = getRelativePath(explorerBasePath)
  const pathSegments = relativePath ? relativePath.split('/').filter(Boolean) : []

  // Build full absolute path for a breadcrumb index
  const getPathAtIndex = (index: number) => {
    if (index < 0) return projectRoot
    return projectRoot + '/' + pathSegments.slice(0, index + 1).join('/')
  }

  // Go up one directory (but not above projectRoot)
  const handleGoUp = () => {
    if (explorerBasePath === projectRoot) return
    const parts = explorerBasePath.split('/')
    const parentPath = parts.slice(0, -1).join('/')
    // Ensure we don't go above projectRoot
    if (parentPath.length >= projectRoot.length) {
      onPathChange(parentPath)
    }
  }

  // Can only go up if we're not at projectRoot
  const canGoUp = explorerBasePath !== projectRoot && explorerBasePath.startsWith(projectRoot)

  return (
    <div className="flex h-full bg-transparent">
      {/* Activity Bar */}
      <div className="w-12 flex flex-col items-center py-3 bg-zinc-900/50 border-r border-white/5 gap-2 backdrop-blur-sm z-10">
        <ActivityIcon
          icon={<Files size={22} strokeWidth={1.5} />}
          active={activeView === 'explorer'}
          onClick={() => setActiveView('explorer')}
        />
        <ActivityIcon
          icon={<Search size={22} strokeWidth={1.5} />}
          active={activeView === 'search'}
          onClick={() => setActiveView('search')}
        />
        <ActivityIcon
          icon={<GitBranch size={22} strokeWidth={1.5} />}
          active={activeView === 'git'}
          onClick={() => setActiveView('git')}
        />
        <ActivityIcon
          icon={<Box size={22} strokeWidth={1.5} />}
          active={activeView === 'extensions'}
          onClick={() => setActiveView('extensions')}
        />
        <div className="flex-1" />
        <ActivityIcon
          icon={<Settings size={22} strokeWidth={1.5} />}
          active={false}
          onClick={() => {}}
        />
      </div>

      {/* Sidebar Content */}
      <div className="flex-1 flex flex-col min-w-0 bg-transparent">
        <div className="h-10 px-5 flex items-center text-[10px] font-bold tracking-widest text-zinc-500 uppercase border-b border-white/5 select-none">
          {activeView === 'explorer' && 'Explorer'}
          {activeView === 'search' && 'Search'}
          {activeView === 'git' && 'Source Control'}
          {activeView === 'extensions' && 'Extensions'}
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {/* Explorer view - keep mounted, hide with CSS */}
          <div className={cn("py-2", activeView !== 'explorer' && "hidden")}>
            {/* Path navigation header */}
            <div className="px-3 py-2 mb-1">
              {/* Breadcrumb path with up button and sync on far right */}
              <div className="flex items-center gap-1 text-[11px]">
                {/* Path breadcrumbs - overflow hidden, right side gets cut */}
                <div className="flex items-center gap-0.5 overflow-hidden flex-1 min-w-0">
                  {/* Project root crumb */}
                  <button
                    onClick={() => onPathChange(projectRoot)}
                    className={cn(
                      "px-1.5 py-0.5 rounded transition-colors font-medium flex-shrink-0 truncate max-w-[100px]",
                      pathSegments.length === 0
                        ? "text-blue-400 bg-blue-500/10"
                        : "text-zinc-400 hover:text-zinc-200 hover:bg-white/10"
                    )}
                    title={projectRoot}
                  >
                    {projectName}
                  </button>
                  {/* Subdirectory crumbs */}
                  {pathSegments.map((segment, i) => (
                    <span key={i} className="flex items-center flex-shrink-0">
                        <ChevronRight size={12} className="text-zinc-600" />
                        <button
                          onClick={() => onPathChange(getPathAtIndex(i))}
                          className={cn(
                            "px-1.5 py-0.5 rounded transition-colors font-medium truncate max-w-[80px]",
                            i === pathSegments.length - 1
                              ? "text-blue-400 bg-blue-500/10"
                              : "text-zinc-400 hover:text-zinc-200 hover:bg-white/10"
                          )}
                          title={segment}
                        >
                          {segment}
                        </button>
                      </span>
                    ))}
                  </div>
                  {/* Up and Sync buttons on far right */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={handleGoUp}
                      disabled={!canGoUp}
                      className={cn(
                        "flex items-center justify-center w-6 h-6 rounded transition-colors",
                        canGoUp
                          ? "text-blue-400 bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20"
                          : "text-zinc-600 bg-zinc-800/50 border border-zinc-700/50 cursor-not-allowed"
                      )}
                      title="Go up one directory"
                    >
                      <ChevronUp size={14} />
                    </button>
                    <button
                      onClick={handleRefresh}
                      className={cn(
                        "flex items-center justify-center w-6 h-6 rounded border transition-all",
                        isRefreshing
                          ? "bg-blue-500/20 border-blue-500/30 text-blue-400 scale-95"
                          : "bg-zinc-800/50 border-zinc-700/50 hover:bg-zinc-700/50 text-zinc-400 hover:text-zinc-200"
                      )}
                      title="Refresh file list"
                    >
                      <RefreshCw size={12} className={isRefreshing ? "animate-spin" : ""} />
                    </button>
                    {syncAvailable && (
                      <button
                        onClick={onExplorerSync}
                        className="flex items-center gap-1 px-1.5 h-6 rounded bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20 text-blue-400 transition-colors"
                        title={`Sync to: ${claudeCwd}`}
                      >
                        <RefreshCw size={10} />
                        <span>sync</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {fileTree}
            </div>

          {/* Git view - keep mounted, hide with CSS */}
          <div className={cn(activeView !== 'git' && "hidden")}>
            {gitStatus}
          </div>

          {/* Search view */}
          <div className={cn("p-6 text-center text-zinc-600 text-sm mt-10 italic", activeView !== 'search' && "hidden")}>
            Search functionality coming soon.
          </div>

          {/* Extensions view */}
          <div className={cn("p-6 text-center text-zinc-600 text-sm mt-10 italic", activeView !== 'extensions' && "hidden")}>
            Extensions coming soon.
          </div>
        </div>
      </div>
    </div>
  )
}
