import React, { useEffect, useRef, useState } from 'react'
import type { CaptureHealthSnapshot, CaptureHealthState } from '@shared/capture-protocol'
import type { CaptureMode } from '@shared/types'
import { useLocale } from '../i18n'
import { Badge, Button } from '../ui'

export function getCaptureHealthPresentation(state: CaptureHealthState, locale: 'zh' | 'en' = 'en') {
  const presentations = {
    starting: { label: locale === 'zh' ? '\u6b63\u5728\u542f\u52a8' : 'Starting', color: 'var(--color-info)' },
    healthy: { label: locale === 'zh' ? '\u5f53\u524d\u5065\u5eb7' : 'Healthy now', color: 'var(--color-success)' },
    degraded: { label: locale === 'zh' ? '\u5df2\u964d\u7ea7' : 'Degraded', color: 'var(--color-warning)' },
    stopped: { label: locale === 'zh' ? '\u5df2\u505c\u6b62' : 'Stopped', color: 'var(--text-muted)' },
    unknown: { label: locale === 'zh' ? '\u672a\u77e5' : 'Unknown', color: 'var(--text-muted)' },
  }
  return presentations[state]
}

interface CaptureHealthPanelProps {
  sessionId: string
  captureHealth?: CaptureHealthSnapshot | null
  captureMode?: CaptureMode
  compact?: boolean
}

const sectionStyle: React.CSSProperties = {
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  background: 'var(--color-surface)',
  color: 'var(--text-secondary)',
  fontSize: 'var(--font-size-2xs)',
  textAlign: 'left',
  overflowWrap: 'anywhere',
}

const detailStyle: React.CSSProperties = {
  padding: 10,
  borderTop: '1px solid var(--color-border)',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

function formatConfirmedAt(timestamp: number | null): string {
  return timestamp === null ? 'Never confirmed' : new Date(timestamp).toLocaleString()
}

export default function CaptureHealthPanel({
  sessionId,
  captureHealth,
  captureMode = 'deep',
  compact = false,
}: CaptureHealthPanelProps) {
  const { locale } = useLocale()
  const localize = (englishText: string, chineseText: string) => locale === 'zh' ? chineseText : englishText
  const panelTitle = localize('Capture health', '\u6293\u53d6\u5065\u5eb7')
  const health = captureHealth?.sessionId === sessionId ? captureHealth : null
  const presentation = getCaptureHealthPresentation(health?.state ?? 'unknown', locale)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const mountedRef = useRef(false)
  const scopeRef = useRef({ sessionId, version: 0 })
  if (scopeRef.current.sessionId !== sessionId) {
    scopeRef.current = { sessionId, version: scopeRef.current.version + 1 }
  }
  useEffect(() => {
    mountedRef.current = true
    setExporting(false)
    setExportError(null)
    return () => { mountedRef.current = false }
  }, [sessionId])

  const exportDiagnostics = async () => {
    const scopeVersion = scopeRef.current.version
    const isCurrentScope = () => mountedRef.current && scopeRef.current.version === scopeVersion
    setExporting(true)
    setExportError(null)
    try {
      if (!window.electronAPI.getCaptureDiagnostics) throw new Error('Diagnostics are unavailable in this preload version.')
      const bundle = await window.electronAPI.getCaptureDiagnostics(sessionId)
      if (!isCurrentScope() || bundle.session.id !== sessionId) return
      await window.electronAPI.exportFile(`capture-diagnostics-${sessionId}.json`, JSON.stringify(bundle, null, 2))
    } catch (error) {
      if (isCurrentScope()) {
        setExportError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (isCurrentScope()) setExporting(false)
    }
  }

  const certaintyLabels = {
    'known-loss': localize('Known loss', '\u5df2\u786e\u8ba4\u4e22\u5931'),
    'unknown-coverage': localize('Unknown coverage', '\u8986\u76d6\u672a\u77e5'),
    'delivery-delay': localize('Delivery delay (not confirmed loss)', '\u4f20\u9001\u5ef6\u8fdf\uff08\u975e\u786e\u8ba4\u4e22\u5931\uff09'),
  }
  const certaintyCounts = Object.entries(certaintyLabels).map(([certainty, label]) => ({
    label,
    count: health?.gaps.filter((gap) => gap.certainty === certainty).length ?? 0,
  }))
  const droppedEvents = health?.gaps.reduce((total, gap) => total + (gap.droppedEvents ?? 0), 0) ?? 0
  const workerLabels = {
    verified: localize('Verified for observed Worker realms', '\u5df2\u89c2\u6d4b\u7684 Worker \u5df2\u9a8c\u8bc1'),
    'late-attachment': localize('Late attachment: early Worker coverage is unknown', '\u9644\u52a0\u8f83\u665a\uff1aWorker \u65e9\u671f\u8986\u76d6\u672a\u77e5'),
    unavailable: localize('Unavailable: Worker instrumentation is not available', '\u4e0d\u53ef\u7528\uff1aWorker \u63d2\u6869\u4e0d\u53ef\u7528'),
    unknown: localize('Unknown: early Worker coverage is not verified', '\u672a\u77e5\uff1aWorker \u65e9\u671f\u8986\u76d6\u672a\u9a8c\u8bc1'),
  }

  return (
    <section aria-label={panelTitle} style={{ ...sectionStyle, width: compact ? '100%' : undefined }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <strong style={{ color: 'var(--text-primary)' }}>{panelTitle}</strong>
        <Badge label={`Deep: ${presentation.label}`} color={presentation.color} size="sm" />
        <span>{localize('Network', '\u7f51\u7edc')}: {health?.network ?? 'unknown'}</span>
        <Button size="sm" loading={exporting} disabled={exporting} onClick={() => void exportDiagnostics()}>
          {localize('Export diagnostics JSON', '\u5bfc\u51fa\u8bca\u65ad JSON')}
        </Button>
      </div>
      <div style={{ color: 'var(--text-muted)' }}>
        {localize('Current health does not prove that no historical data was lost. Network capture and Deep coverage are independent.', '\u5f53\u524d\u5065\u5eb7\u4e0d\u4ee3\u8868\u5386\u53f2\u65e0\u4e22\u5931\u3002\u7f51\u7edc\u6293\u53d6\u4e0e Deep \u8986\u76d6\u72ec\u7acb\u3002')}
      </div>
      {captureMode === 'passive' && <div>Passive mode: Deep hooks and interactions are not enabled.</div>}
      {(!health || health.state === 'unknown') && (
        <div role="status">{localize('No capture health data: historical coverage is unknown, not healthy.', '\u65e0\u6293\u53d6\u5065\u5eb7\u6570\u636e\uff1a\u5386\u53f2\u8986\u76d6\u672a\u77e5\uff0c\u4e0d\u80fd\u89c6\u4e3a\u5065\u5eb7\u3002')}</div>
      )}
      <div style={{ color: health?.workerCoverage === 'unavailable' ? 'var(--color-warning)' : undefined }}>
        {localize('Worker coverage', 'Worker \u8986\u76d6')}: {workerLabels[health?.workerCoverage ?? 'unknown']}
      </div>
      {health?.persistenceError && <div role="alert" style={{ color: 'var(--color-error)' }}>Persistence: {health.persistenceError}</div>}
      <div>
        {localize('Historical gaps', '\u5386\u53f2\u7f3a\u53e3')}: {health?.gaps.length ?? 0} | {certaintyCounts.map(({ label, count }) => `${label}: ${count}`).join(' | ')}
        {' | '}{localize('Known dropped events', '\u5df2\u77e5\u4e22\u5931\u4e8b\u4ef6')}: {droppedEvents}
      </div>
      <details open={!compact}>
        <summary style={{ cursor: 'pointer' }}>{localize('Realm details', '\u6267\u884c\u57df\u8be6\u60c5')} ({health?.realms.length ?? 0})</summary>
        {!health?.realms.length && <div style={detailStyle}>No observed realms. This does not establish complete coverage.</div>}
        {health?.realms.map((realm) => (
          <div key={`${realm.runId}:${realm.realmId}`} style={detailStyle}>
            <strong>{realm.kind}: {realm.realmId}</strong>
            <div>State: {realm.state} | Transport: {realm.transport}</div>
            <div>Installation: {Object.entries(realm.installed).map(([hookName, status]) => `${hookName}: ${status}`).join(', ') || 'Unknown'}</div>
            <div>Pending: {realm.pendingEvents} events / {realm.pendingBytes} bytes | Dropped: {realm.droppedEvents}</div>
            <div>Last confirmed: {formatConfirmedAt(realm.lastConfirmedAt)}</div>
            <div>Early injection: {realm.earlyInjection ? 'Verified for this realm' : 'Unknown / attached late'}</div>
            <div>Reason: {realm.reason ?? 'None reported'}</div>
          </div>
        ))}
      </details>
      {!!health?.gaps.length && (
        <details open={!compact}>
          <summary style={{ cursor: 'pointer' }}>{localize('Historical gap details', '\u5386\u53f2\u7f3a\u53e3\u8be6\u60c5')}</summary>
          {health.gaps.map((gap, index) => (
            <div key={`${gap.runId}:${gap.realmId}:${gap.startedAt}:${index}`} style={detailStyle}>
              <strong>{certaintyLabels[gap.certainty]}</strong>
              <div>{gap.reason}</div>
              <div>Realm: {gap.realmId ?? 'Session / unknown realm'} | Run: {gap.runId}</div>
              <div>{formatConfirmedAt(gap.startedAt)} - {gap.endedAt === null ? 'Open' : formatConfirmedAt(gap.endedAt)}</div>
              <div>Dropped events: {gap.droppedEvents ?? 'Unknown'}</div>
            </div>
          ))}
        </details>
      )}
      <div style={{ color: 'var(--text-muted)' }}>Diagnostics omit URLs, bodies, headers, cookies, hook arguments, interaction values and free-text reasons.</div>
      {exportError && <div role="alert" style={{ color: 'var(--color-error)' }}>{exportError}</div>}
    </section>
  )
}
