import React from 'react'
import { formatContextUsagePercent } from '@shared/token-estimate'
import { useLocale } from '../i18n'
import type { SessionStatus } from '@shared/types'
import type { CaptureHealthSnapshot } from '@shared/capture-protocol'
import { getCaptureHealthPresentation } from './CaptureHealthPanel'
import type { AppView } from './Titlebar'
import styles from './StatusBar.module.css'

interface StatusBarProps {
  status: SessionStatus | null
  requestCount: number
  hookCount: number
  interactionCount?: number
  sessionName?: string
  activeView?: AppView
  llmModel?: string
  tokenCount?: number
  /** used/usable 0..1+ */
  contextUsageRatio?: number
  contextNearPeak?: boolean
  captureHealth?: CaptureHealthSnapshot | null
}

const StatusBar: React.FC<StatusBarProps> = ({
  status,
  requestCount,
  hookCount,
  interactionCount = 0,
  sessionName,
  activeView = 'browser',
  llmModel,
  tokenCount,
  contextUsageRatio,
  contextNearPeak,
  captureHealth,
}) => {
  const { t, locale } = useLocale()
  const statusLabels: Record<string, { color: string; label: string; pulse: boolean }> = {
    running: { color: 'var(--color-success)', label: t('capture.running'), pulse: true },
    paused: { color: 'var(--color-warning)', label: t('capture.paused'), pulse: false },
    stopped: { color: 'var(--text-muted)', label: t('capture.stopped'), pulse: false },
  }
  const statusCfg = status ? statusLabels[status] : null
  const deepPresentation = getCaptureHealthPresentation(captureHealth?.state ?? 'unknown', locale)
  const network = captureHealth?.network ?? 'unknown'
  const networkColor = network === 'running' ? 'var(--color-success)' : 'var(--text-muted)'

  return (
    <div className={styles.statusBar}>
      {/* Status dot + label */}
      <div className={styles.item}>
        <span
          className={`${styles.dot} ${statusCfg?.pulse ? styles.pulse : ''}`}
          style={{ background: statusCfg?.color ?? 'var(--text-disabled)' }}
        />
        <span className={styles.label}>{t('status.session')}</span>
        <span className={styles.value} style={{ color: statusCfg?.color }}>
          {statusCfg?.label ?? 'Idle'}
        </span>
      </div>

      {status && (
        <>
          <div className={styles.item} title={locale === 'zh' ? '网络抓取状态与 Deep 覆盖独立' : 'Network capture is independent of Deep coverage'}>
            <span className={styles.label}>{locale === 'zh' ? '网络' : 'Network'}</span>
            <span className={styles.value} style={{ color: networkColor }}>
              {network === 'unknown' ? (locale === 'zh' ? '未知' : 'Unknown') : statusLabels[network]?.label}
            </span>
          </div>
          <div className={styles.item} title={locale === 'zh' ? '当前健康不代表历史无丢失；查看抓取健康详情' : 'Healthy now does not mean no historical loss; see Capture health details'}>
            <span className={styles.label}>Deep</span>
            <span className={styles.value} style={{ color: deepPresentation.color }}>{deepPresentation.label}</span>
            {!!captureHealth?.gaps.length && (
              <span style={{ color: 'var(--color-warning)' }}>
                {locale === 'zh' ? '历史缺口' : 'Historical gaps'} {captureHealth.gaps.length}
              </span>
            )}
          </div>
        </>
      )}

      {/* Request count */}
      <div className={styles.item}>
        <span className={styles.label}>{t('status.requests')}</span>
        <span className={styles.value}>{requestCount}</span>
      </div>

      {/* Hooks count — browser/inspector only */}
      {activeView !== 'report' && (
        <div className={styles.item}>
          <span className={styles.label}>{t('status.hooks')}</span>
          <span className={styles.value}>{hookCount}</span>
        </div>
      )}

      {/* Interaction recording count */}
      {activeView !== 'report' && interactionCount > 0 && (
        <div className={styles.item}>
          <span
            className={`${styles.dot} ${status === 'running' ? styles.pulse : ''}`}
            style={{ background: status === 'running' ? 'var(--color-error)' : 'var(--text-muted)' }}
          />
          <span className={styles.label}>{t('data.interactions')}</span>
          <span className={styles.value}>{interactionCount}</span>
        </div>
      )}

      {/* Report view: LLM + Tokens */}
      {activeView === 'report' && llmModel && (
        <div className={styles.item}>
          <span className={styles.label}>{t('status.reportModel')}</span>
          <span className={styles.value}>{llmModel}</span>
        </div>
      )}
      {activeView === 'report' && tokenCount != null && tokenCount > 0 && (
        <div className={styles.item}>
          <span className={styles.label}>{t('status.totalUsage')}</span>
          <span className={styles.value}>{tokenCount.toLocaleString()}</span>
        </div>
      )}
      {activeView === 'report' && contextUsageRatio != null && (
        <div className={styles.item}>
          <span className={styles.label}>{t('status.context')}</span>
          <span
            className={styles.value}
            style={{ color: contextNearPeak || contextUsageRatio >= 0.85 ? 'var(--color-error)' : 'var(--text-secondary)' }}
          >
            {formatContextUsagePercent(contextUsageRatio)}
          </span>
        </div>
      )}

      <div className={styles.spacer} />

      {/* Session name on the right */}
      {sessionName && (
        <div className={styles.item}>
          <span className={styles.value}>{sessionName}</span>
        </div>
      )}
    </div>
  )
}

export default StatusBar
