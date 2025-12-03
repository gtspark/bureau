import { createContext, useContext, useCallback, useState, useEffect, ReactNode } from 'react'
import { useWebSocket, useWebSocketMessages } from './WebSocketContext'
import { Session, SessionWithHistory, OutputEntry } from '../types/session'

interface SessionContextValue {
  activeSession: SessionWithHistory | null
  sessions: Session[]
  createSession: (name: string, projectRoot: string) => void
  switchSession: (id: string) => void
  renameSession: (id: string, name: string) => void
  deleteSession: (id: string) => void
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const { send, connected } = useWebSocket()
  const [activeSession, setActiveSession] = useState<SessionWithHistory | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])

  // Handle session-related messages
  useWebSocketMessages((msg) => {
    switch (msg.type) {
      case 'connected': {
        // Initial connection with session data
        const session = msg.session as SessionWithHistory | null
        const sessionsList = msg.sessions as Session[] | undefined
        if (session) {
          setActiveSession(session)
        }
        if (sessionsList) {
          setSessions(sessionsList)
        }
        break
      }

      case 'sessions:switched': {
        const session = msg.session as SessionWithHistory
        setActiveSession(session)
        break
      }

      case 'sessions:created': {
        const session = msg.session as Session
        // Add only if not already in the list (avoid duplicates from race with sessions:list)
        setSessions(prev => {
          if (prev.some(s => s.id === session.id)) {
            return prev
          }
          return [session, ...prev]
        })
        break
      }

      case 'sessions:renamed': {
        const session = msg.session as Session
        setSessions(prev => prev.map(s => s.id === session.id ? session : s))
        if (activeSession?.id === session.id) {
          setActiveSession(prev => prev ? { ...prev, name: session.name } : null)
        }
        break
      }

      case 'sessions:deleted': {
        const { id } = msg as { id: string; type: string }
        setSessions(prev => prev.filter(s => s.id !== id))
        break
      }

      case 'sessions:list': {
        const sessionsList = msg.sessions as Session[]
        setSessions(sessionsList)
        break
      }

      case 'claude:message': {
        // Append to active session history
        if (activeSession && msg.sessionId === activeSession.id) {
          const entry: OutputEntry = {
            timestamp: new Date().toISOString(),
            type: 'claude',
            content: JSON.stringify(msg.message),
          }
          setActiveSession(prev => prev ? {
            ...prev,
            history: [...prev.history, entry]
          } : null)
        }
        break
      }
    }
  }, [activeSession])

  // Request session list on connection
  useEffect(() => {
    if (connected) {
      send({ type: 'sessions:list' })
    }
  }, [connected, send])

  const createSession = useCallback((name: string, projectRoot: string) => {
    send({ type: 'sessions:create', name, projectRoot })
  }, [send])

  const switchSession = useCallback((id: string) => {
    send({ type: 'sessions:switch', id })
  }, [send])

  const renameSession = useCallback((id: string, name: string) => {
    send({ type: 'sessions:rename', id, name })
  }, [send])

  const deleteSession = useCallback((id: string) => {
    send({ type: 'sessions:delete', id })
  }, [send])

  return (
    <SessionContext.Provider value={{
      activeSession,
      sessions,
      createSession,
      switchSession,
      renameSession,
      deleteSession,
    }}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession() {
  const context = useContext(SessionContext)
  if (!context) {
    throw new Error('useSession must be used within a SessionProvider')
  }
  return context
}
