import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Badge } from '../ui'
import { IconGlobe, IconLoading, IconMaximize } from '../ui/Icons'
import type { BrowserSessionRuntimeStatus, CaptureMode, Session } from '@shared/types'
import type { CaptureHealthSnapshot } from '@shared/capture-protocol'
import { useCaptureHealth } from '../hooks/useCapture'
import { useLocale } from '../i18n'
import CaptureHealthPanel, { getCaptureHealthPresentation } from './CaptureHealthPanel'
import styles from './ExternalBrowserSurface.module.css'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ExternalBrowserSurfaceProps {
  session: Session
  onCaptureModeChange: (mode: CaptureMode) => Promise<void>
  captureHealth?: CaptureHealthSnapshot | null
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
  captureHealth,
}: ExternalBrowserSurfaceProps) {
  const sessionId = session.id
  const { locale } = useLocale()
  const localHealth = useCaptureHealth(captureHealth === undefined ? sessionId : null)
  const health = captureHealth === undefined ? localHealth : captureHealth
  const scopedHealth = health?.sessionId === sessionId ? health : null
  const deepPresentation = getCaptureHealthPresentation(scopedHealth?.state ?? 'unknown', locale)
  const mountedRef = useRef(true)
  const scopeRef = useRef({ sessionId, version: 0 })
  const refreshVersionRef = useRef(0)
  if (scopeRef.current.sessionId !== sessionId) {
    scopeRef.current = { sessionId, version: scopeRef.current.version + 1 }
  }
  const [status, setStatus] = useState<BrowserSessionRuntimeStatus | null>(null)
  const [focusing, setFocusing] = useState(false)
  const [focusError, setFocusError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [modeBusy, setModeBusy] = useState(false)

  const refresh = useCallback(async () => {
    const scopeVersion = scopeRef.current.version
    const refreshVersion = ++refreshVersionRef.current
    const isCurrentRefresh = () => mountedRef.current && scopeRef.current.version === scopeVersion
      && refreshVersionRef.current === refreshVersion
    try {
      const nextStatus = await window.electronAPI.getBrowserSessionStatus(sessionId)
      if (isCurrentRefresh() && (nextStatus.sessionId === sessionId || nextStatus.sessionId === null)) {
        setStatus(nextStatus)
        setFocusError(nextStatus.error)
        setWarning(nextStatus.warning ?? null)
      }
    } catch (error) {
      if (isCurrentRefresh()) setFocusError(errorMessage(error))
    }
  }, [sessionId])

  useEffect(() => {
    mountedRef.current = true
    setStatus(null)
    setFocusError(null)
    setWarning(null)
    setFocusing(false)
    setModeBusy(false)
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => {
      mountedRef.current = false
      window.clearInterval(timer)
    }
  }, [refresh])

  const handleFocus = async () => {
    const scopeVersion = scopeRef.current.version
    const isCurrentScope = () => mountedRef.current && scopeRef.current.version === scopeVersion
    setFocusing(true)
    setFocusError(null)
    try {
      await window.electronAPI.focusBrowser(sessionId)
    } catch (error) {
      if (isCurrentScope()) setFocusError(errorMessage(error))
    } finally {
      if (isCurrentScope()) setFocusing(false)
    }
  }

  const handleModeChange = async (mode: CaptureMode) => {
    if (mode === session.capture_mode || session.status !== 'stopped' || modeBusy) return
    const scopeVersion = scopeRef.current.version
    const isCurrentScope = () => mountedRef.current && scopeRef.current.version === scopeVersion
    setModeBusy(true)
    setFocusError(null)
    try {
      await onCaptureModeChange(mode)
      if (isCurrentScope()) await refresh()
    } catch (error) {
      if (isCurrentScope()) setFocusError(errorMessage(error))
    } finally {
      if (isCurrentScope()) setModeBusy(false)
    }
  }

  const pending = !status || status.state === 'opening'
  const presentation = status
    ? statePresentation[status.state]
    : statePresentation.opening

  return (
    <div className={styles.surface} style={{ overflow: 'auto' }}>
      <div className={styles.content} style={{ width: 'min(100%, 720px)' }}>
        <div className={styles.browserMark} aria-hidden="true">
          <IconGlobe size={24} />
        </div>
        <h2 className={styles.title}>CloakBrowser</h2>
        <div className={styles.statusRow}>
          <Badge
            color={presentation.color}
            label={`Browser: ${presentation.label}`}
            pulse={pending}
            size="sm"
          />
          <span className={styles.divider} />
          <span className={styles.version}>{status?.version ? `Chromium ${status.version}` : '版本未知'}</span>
        </div>
        <div className={styles.statusRow}>
          <Badge color={deepPresentation.color} label={`Deep: ${deepPresentation.label}`} size="sm" />
          <span className={styles.version}>{locale === 'zh' ? '浏览器已连接不等于 Deep 健康' : 'Browser ready does not imply Deep health'}</span>
        </div>
        {focusError && <div className={styles.error} role="alert">{focusError}</div>}
        {!focusError && warning && (
          <div className={styles.error} role="status" style={{ color: 'var(--color-warning)' }}>
            {warning}
          </div>
        )}
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
        <div style={{ width: '100%', marginTop: 16 }}>
          <CaptureHealthPanel
            key={sessionId}
            sessionId={sessionId}
            captureHealth={scopedHealth}
            captureMode={session.capture_mode}
            compact
          />
        </div>
      </div>
    </div>
  )
}
