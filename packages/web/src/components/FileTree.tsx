import { useEffect, useState, useCallback } from 'react'
import { useWebSocket, useWebSocketMessages } from '../contexts/WebSocketContext'
import { ChevronRight, ChevronDown, Folder, FileCode, FileJson, File, FileText, Loader2 } from 'lucide-react'
import { cn } from '../lib/cn'

interface FileEntry {
  name: string
  type: 'file' | 'directory'
  path: string
  size: number
  modifiedTime: string
}

interface TreeNode extends FileEntry {
  children?: TreeNode[]
  isLoading?: boolean
}

interface FileTreeProps {
  onFileSelect?: (path: string, content: string) => void
  onFolderNavigate?: (path: string) => void
  basePath?: string
}

function getFileIcon(filename: string, type: 'file' | 'directory', isOpen?: boolean) {
  if (type === 'directory') {
    return <Folder size={14} className={cn("text-blue-400", isOpen && "fill-blue-500/20")} />
  }

  const ext = filename.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
      return <FileCode size={14} className="text-blue-400" />
    case 'js':
    case 'jsx':
      return <FileCode size={14} className="text-yellow-400" />
    case 'json':
      return <FileJson size={14} className="text-yellow-400" />
    case 'md':
      return <FileText size={14} className="text-gray-400" />
    case 'html':
      return <FileCode size={14} className="text-orange-400" />
    case 'css':
    case 'scss':
      return <FileCode size={14} className="text-pink-400" />
    default:
      return <File size={14} className="text-zinc-400" />
  }
}

function FileTreeNode({
  node,
  depth,
  expanded,
  selected,
  onToggle,
  onClick,
  onSelect,
  onNavigate,
  basePath,
}: {
  node: TreeNode
  depth: number
  expanded: Set<string>
  selected: string | null
  onToggle: (node: TreeNode) => void
  onClick: (node: TreeNode) => void
  onSelect: (path: string) => void
  onNavigate?: (path: string) => void
  basePath: string
}) {
  const isExpanded = expanded.has(node.path)
  const isSelected = selected === node.path

  const handleDragStart = (e: React.DragEvent) => {
    if (node.type === 'file') {
      e.dataTransfer.setData('text/plain', node.path)
      e.dataTransfer.effectAllowed = 'copy'
    }
  }

  return (
    <div className="select-none">
      <div
        className={cn(
          "flex items-center gap-1.5 py-0.5 px-2 cursor-pointer text-sm text-zinc-300 transition-colors border border-transparent",
          "hover:bg-zinc-800",
          isSelected && "bg-blue-500/20 text-blue-100"
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        draggable={node.type === 'file'}
        onDragStart={handleDragStart}
        onClick={() => {
          // Single click just selects for both files and folders
          onSelect(node.path)
        }}
        onDoubleClick={() => {
          if (node.type === 'directory') {
            // Double click expands/collapses the folder
            onToggle(node)
            // Also navigate if handler provided
            if (onNavigate) {
              // Construct absolute path: basePath + node name
              // node.path is relative to projectRoot, but we need absolute for navigation
              const absolutePath = basePath.endsWith('/')
                ? basePath + node.name
                : basePath + '/' + node.name
              onNavigate(absolutePath)
            }
          } else {
            // Double click opens the file
            onClick(node)
          }
        }}
      >
        <span className="opacity-70 flex-shrink-0 w-4 h-4 flex items-center justify-center">
          {node.type === 'directory' && (
            node.isLoading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : isExpanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          )}
        </span>

        <span className="flex-shrink-0">
          {getFileIcon(node.name, node.type, isExpanded)}
        </span>

        <span className="truncate">{node.name}</span>
      </div>

      {node.type === 'directory' && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selected={selected}
              onToggle={onToggle}
              onClick={onClick}
              onSelect={onSelect}
              onNavigate={onNavigate}
              basePath={basePath}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function FileTree({ onFileSelect, onFolderNavigate, basePath = '.' }: FileTreeProps) {
  const { connected, send } = useWebSocket()
  const [tree, setTree] = useState<TreeNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set([basePath]))
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [currentBasePath, setCurrentBasePath] = useState(basePath)

  const updateTreeWithChildren = useCallback((path: string, children: TreeNode[]) => {
    setTree(prevTree => {
      const updateNode = (nodes: TreeNode[]): TreeNode[] => {
        return nodes.map(node => {
          if (node.path === path) {
            return { ...node, children, isLoading: false }
          }
          if (node.children) {
            return { ...node, children: updateNode(node.children) }
          }
          return node
        })
      }

      // If tree is empty or path matches first request, set as root
      if (prevTree.length === 0) {
        return children
      }

      return updateNode(prevTree)
    })
  }, [])

  // Track the path we're expecting a response for
  const [pendingPath, setPendingPath] = useState<string | null>(basePath)

  // Reset and reload when basePath changes
  useEffect(() => {
    if (basePath !== currentBasePath) {
      setCurrentBasePath(basePath)
      setTree([])
      setExpanded(new Set([basePath]))
      setSelected(null)
      setLoading(true)
      setPendingPath(basePath)
      // Request new file list
      if (connected) {
        send({ type: 'files:list', path: basePath })
      }
    }
  }, [basePath, currentBasePath, connected, send])

  // Handle initial connection / reconnection only
  useEffect(() => {
    if (connected && tree.length === 0 && pendingPath === null) {
      // Only request on reconnect if we don't have data and no pending request
      setLoading(true)
      setPendingPath(currentBasePath)
      send({ type: 'files:list', path: currentBasePath })
    } else if (!connected) {
      // Reset state on disconnect
      setTree([])
      setLoading(true)
      setPendingPath(null)
    }
  }, [connected, send, currentBasePath, tree.length, pendingPath])

  useWebSocketMessages((msg) => {
    switch (msg.type) {
      case 'files:tree': {
        const responsePath = msg.path as string
        const entries = msg.entries as FileEntry[]
        const nodes: TreeNode[] = entries.map(e => ({
          ...e,
          children: e.type === 'directory' ? undefined : undefined,
        }))

        // Check if this response matches what we're waiting for
        // The response path might be relative while currentBasePath/pendingPath are absolute
        // So check if responsePath matches OR if currentBasePath ends with responsePath
        const isRootResponse =
          responsePath === currentBasePath ||
          responsePath === pendingPath ||
          currentBasePath.endsWith('/' + responsePath) ||
          (pendingPath && pendingPath.endsWith('/' + responsePath))

        if (isRootResponse) {
          setTree(nodes)
          setPendingPath(null)
          setLoading(false)
        } else {
          // This is a response for expanding a subdirectory
          updateTreeWithChildren(responsePath, nodes)
        }
        break
      }

      case 'file:content': {
        if (onFileSelect) {
          onFileSelect(msg.path as string, msg.content as string)
        }
        break
      }
    }
  }, [onFileSelect, updateTreeWithChildren, currentBasePath, pendingPath])

  const toggleDirectory = useCallback((node: TreeNode) => {
    const isExpanded = expanded.has(node.path)

    if (isExpanded) {
      setExpanded(prev => {
        const next = new Set(prev)
        next.delete(node.path)
        return next
      })
    } else {
      setExpanded(prev => new Set([...prev, node.path]))

      if (!node.children) {
        setTree(prevTree => {
          const markLoading = (nodes: TreeNode[]): TreeNode[] => {
            return nodes.map(n => {
              if (n.path === node.path) {
                return { ...n, isLoading: true }
              }
              if (n.children) {
                return { ...n, children: markLoading(n.children) }
              }
              return n
            })
          }
          return markLoading(prevTree)
        })

        send({ type: 'files:list', path: node.path })
      }
    }
  }, [expanded, send])

  const handleFileClick = useCallback((node: TreeNode) => {
    setSelected(node.path)
    send({ type: 'file:read', path: node.path })
  }, [send])

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-zinc-500 text-sm p-4">
        <Loader2 size={14} className="animate-spin" />
        <span>{connected ? 'Loading...' : 'Connecting...'}</span>
      </div>
    )
  }

  if (tree.length === 0) {
    return (
      <div className="text-zinc-600 text-sm italic p-4">
        No files found
      </div>
    )
  }

  return (
    <div className="flex flex-col py-1">
      {tree.map((node) => (
        <FileTreeNode
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          selected={selected}
          onToggle={toggleDirectory}
          onClick={handleFileClick}
          onSelect={setSelected}
          onNavigate={onFolderNavigate}
          basePath={currentBasePath}
        />
      ))}
    </div>
  )
}
