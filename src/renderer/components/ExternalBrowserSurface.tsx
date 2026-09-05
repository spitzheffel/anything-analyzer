import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Badge } from '../ui'
import { IconGlobe, IconLoading, IconMaximize } from '../ui/Icons'
import type { BrowserSessionRuntimeStatus, CaptureMode, Session } from '@shared/types'
import styles from './ExternalBrowserSurface.module.css'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ExternalBrowserSurfaceProps {
  session: Session
  onCaptureModeChange: (mode: CaptureMode) => Promise<void>
}

const statePresentation: Record<
  BrowserSessionRuntimeStatus['state'],
  { label: string; color: string }
> = {
  closed: { label: '未连接', color: 'var(--text-muted)' },
  opening: { label: '正在连接', color: 'var(--color-info)' },
  ready: { label: '已连接', color: 'var(--color-success)' },
  error: { label: '连接异常', color: 'var(--color-error)' },
}

export default function ExternalBrowserSurface({
  session,
  onCaptureModeChange,
}: ExternalBrowserSurfaceProps) {
  const sessionId = session.id
  const mountedRef = useRef(true)
  const [status, setStatus] = useState<BrowserSessionRuntimeStatus | null>(null)
  const [focusing, setFocusing] = useState(false)
  const [focusError, setFocusError] = useState<string | null>(null)
  const [modeBusy, setModeBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const nextStatus = await window.electronAPI.getBrowserSessionStatus(sessionId)
      if (mountedRef.current) {
        setStatus(nextStatus)
        setFocusError(nextStatus.error)
      }
    } catch (error) {
      if (mountedRef.current) setFocusError(errorMessage(error))
    }
  }, [sessionId])

  useEffect(() => {
    mountedRef.current = true
    setStatus(null)
    setFocusError(null)
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => {
      mountedRef.current = false
      window.clearInterval(timer)
    }
  }, [refresh])

  const handleFocus = async () => {
    setFocusing(true)
    setFocusError(null)
    try {
      await window.electronAPI.focusBrowser(sessionId)
    } catch (error) {
      if (mountedRef.current) setFocusError(errorMessage(error))
    } finally {
      if (mountedRef.current) setFocusing(false)
    }
  }

  const handleModeChange = async (mode: CaptureMode) => {
    if (mode === session.capture_mode || session.status !== 'stopped' || modeBusy) return
    setModeBusy(true)
    setFocusError(null)
    try {
      await onCaptureModeChange(mode)
      await refresh()
    } catch (error) {
      if (mountedRef.current) setFocusError(errorMessage(error))
    } finally {
      if (mountedRef.current) setModeBusy(false)
    }
  }

  const pending = !status || status.state === 'opening'
  const presentation = status
    ? statePresentation[status.state]
    : statePresentation.opening

  return (
    <div className={styles.surface}>
      <div className={styles.content}>
        <div className={styles.browserMark} aria-hidden="true">
          <IconGlobe size={24} />
        </div>
        <h2 className={styles.title}>CloakBrowser</h2>
        <div className={styles.statusRow}>
          <Badge
            color={presentation.color}
            label={presentation.label}
            pulse={pending}
            size="sm"
          />
          <span className={styles.divider} />
          <span className={styles.version}>{status?.version ? `Chromium ${status.version}` : '版本未知'}</span>
        </div>
        {focusError && <div className={styles.error} role="alert">{focusError}</div>}
        <div className={styles.modeRow}>
          <span className={styles.modeLabel}>Capture</span>
          <div className={styles.segmented} role="radiogroup" aria-label="Capture mode">
            {(['passive', 'deep'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={session.capture_mode === mode}
                className={session.capture_mode === mode ? styles.segmentActive : ''}
                disabled={session.status !== 'stopped' || modeBusy}
                onClick={() => void handleModeChange(mode)}
              >
                {mode === 'passive' ? 'Passive' : 'Deep'}
              </button>
            ))}
          </div>
        </div>
        {session.status !== 'stopped' && (
          <div className={styles.modeHint}>停止抓取后可切换模式</div>
        )}
        <Button
          variant="primary"
          icon={focusing ? <IconLoading size={14} /> : <IconMaximize size={14} />}
          loading={focusing}
          disabled={pending}
          onClick={() => void handleFocus()}
        >
          {status?.state === 'ready' ? '聚焦浏览器' : '打开浏览器'}
        </Button>
      </div>
    </div>
  )
}
