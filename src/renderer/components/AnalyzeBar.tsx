import React, { useState, useEffect } from 'react'
import { useLocale } from '../i18n'
import type { PromptTemplate } from '../../shared/types'
import styles from './AnalyzeBar.module.css'

interface AnalyzeBarProps {
  onAnalyze: (purpose?: string) => void
  onExport: () => void
  onExportHar?: () => void
  hasRequests: boolean
  isAnalyzing: boolean
  isStopped: boolean
  selectedSeqCount: number
  totalCount: number
}

const AnalyzeBar: React.FC<AnalyzeBarProps> = ({
  onAnalyze,
  onExport,
  onExportHar,
  hasRequests,
  isAnalyzing,
  isStopped,
  selectedSeqCount,
  totalCount,
}) => {
  const { t } = useLocale()
  const [purposeId, setPurposeId] = useState('auto')
  const [templates, setTemplates] = useState<PromptTemplate[]>([])

  useEffect(() => {
    window.electronAPI.getPromptTemplates().then(setTemplates).catch(() => {})
  }, [])

  const handleAnalyze = () => {
    if (purposeId === 'auto') {
      onAnalyze(undefined)
    } else {
      onAnalyze(purposeId)
    }
  }

  const handleAnalyzeSelected = () => {
    if (purposeId === 'auto') {
      onAnalyze(undefined)
    } else {
      onAnalyze(purposeId)
    }
  }

  const canAnalyze = isStopped && hasRequests && !isAnalyzing

  return (
    <div className={styles.analyzeBar}>
      <select
        className={styles.analyzeSelect}
        value={purposeId}
        onChange={(e) => setPurposeId(e.target.value)}
        disabled={isAnalyzing}
      >
        <option value="auto">▾ {t('capture.autoDetect') ?? '自动检测'}</option>
        {templates.map((tpl) => (
          <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
        ))}
      </select>

      <button
        className={styles.analyzeBtnPrimary}
        disabled={!canAnalyze}
        onClick={handleAnalyze}
      >
        ✦ {t('capture.analyze')}
      </button>

      {selectedSeqCount > 0 && (
        <button
          className={styles.analyzeBtnDim}
          disabled={!canAnalyze}
          onClick={handleAnalyzeSelected}
        >
          {t('capture.analyzeSelected', { count: selectedSeqCount })}
        </button>
      )}

      <div className={styles.spacer} />

      <div className={styles.info}>
        {selectedSeqCount > 0
          ? `${t('data.selected') ?? '已选'} ${selectedSeqCount} / ${t('data.total') ?? '共'} ${totalCount} ${t('data.requests')}`
          : `${t('data.total') ?? '共'} ${totalCount} ${t('data.requests')}`
        }
      </div>

      <button
        className={styles.analyzeBtnDim}
        disabled={!(isStopped && hasRequests) || isAnalyzing}
        onClick={onExport}
        style={{ marginLeft: 8 }}
      >
        ⬇ {t('data.export')}
      </button>
      {onExportHar && (
        <button
          className={styles.analyzeBtnDim}
          disabled={!(isStopped && hasRequests) || isAnalyzing}
          onClick={onExportHar}
          style={{ marginLeft: 6 }}
          title="HTTP Archive 1.2"
        >
          ⬇ {t('data.exportHar')}
        </button>
      )}
    </div>
  )
}

export default AnalyzeBar
