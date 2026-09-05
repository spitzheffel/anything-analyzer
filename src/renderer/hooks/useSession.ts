import { useState, useCallback, useEffect, useMemo } from 'react'
import type { CaptureMode, CreateSessionOptions, Session } from '../../shared/types'

export interface UseSessionReturn {
  sessions: Session[]
  currentSessionId: string | null
  currentSession: Session | null
  loading: boolean
  loadSessions: () => Promise<void>
  createSession: (name: string, url: string, options?: CreateSessionOptions) => Promise<void>
  selectSession: (id: string | null) => void
  deleteSession: (id: string, retainProfile?: boolean) => Promise<void>
  setCaptureMode: (id: string, mode: CaptureMode) => Promise<void>
  startCapture: () => Promise<void>
  resumeCapture: () => Promise<void>
  pauseCapture: () => Promise<void>
  stopCapture: () => Promise<void>
}

export function useSession(): UseSessionReturn {
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const currentSession = useMemo(
    () => sessions.find((s) => s.id === currentSessionId) ?? null,
    [sessions, currentSessionId]
  )

  const loadSessions = useCallback(async () => {
    try {
      setLoading(true)
      const list = await window.electronAPI.listSessions()
      setSessions(list)
    } catch (err) {
      console.error('Failed to load sessions:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const createSession = useCallback(async (name: string, url: string, options?: CreateSessionOptions) => {
    try {
      const session = await window.electronAPI.createSession(name, url, options)
      setSessions((prev) => [...prev, session])
      setCurrentSessionId(session.id)
    } catch (err) {
      console.error('Failed to create session:', err)
      throw err
    }
  }, [])

  const selectSession = useCallback((id: string | null) => {
    setCurrentSessionId(id)
  }, [])

  const deleteSession = useCallback(
    async (id: string, retainProfile = false) => {
      try {
        await window.electronAPI.deleteSession(id, { retainProfile })
        setSessions((prev) => prev.filter((s) => s.id !== id))
        if (currentSessionId === id) {
          setCurrentSessionId(null)
        }
      } catch (err) {
        console.error('Failed to delete session:', err)
        throw err
      }
    },
    [currentSessionId]
  )

  const setCaptureMode = useCallback(async (id: string, mode: CaptureMode) => {
    const updated = await window.electronAPI.setCaptureMode(id, mode)
    setSessions((previous) =>
      previous.map((session) => session.id === id ? updated : session)
    )
  }, [])

  const startCapture = useCallback(async () => {
    if (!currentSessionId) return
    try {
      await window.electronAPI.startCapture(currentSessionId)
      // Reload from DB to ensure UI stays in sync (avoids stale closure issues)
      await loadSessions()
    } catch (err) {
      console.error('Failed to start capture:', err)
      throw err
    }
  }, [currentSessionId, loadSessions])

  const resumeCapture = useCallback(async () => {
    if (!currentSessionId) return
    try {
      await window.electronAPI.resumeCapture(currentSessionId)
      await loadSessions()
    } catch (err) {
      console.error('Failed to resume capture:', err)
      throw err
    }
  }, [currentSessionId, loadSessions])

  const pauseCapture = useCallback(async () => {
    if (!currentSessionId) return
    try {
      await window.electronAPI.pauseCapture(currentSessionId)
      await loadSessions()
    } catch (err) {
      console.error('Failed to pause capture:', err)
      throw err
    }
  }, [currentSessionId, loadSessions])

  const stopCapture = useCallback(async () => {
    if (!currentSessionId) return
    try {
      await window.electronAPI.stopCapture(currentSessionId)
      await loadSessions()
    } catch (err) {
      console.error('Failed to stop capture:', err)
      throw err
    }
  }, [currentSessionId, loadSessions])

  // Load sessions on mount
  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  return {
    sessions,
    currentSessionId,
    currentSession,
    loading,
    loadSessions,
    createSession,
    selectSession,
    deleteSession,
    setCaptureMode,
    startCapture,
    resumeCapture,
    pauseCapture,
    stopCapture
  }
}
