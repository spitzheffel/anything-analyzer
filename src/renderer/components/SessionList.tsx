import React, { useState, useEffect, useCallback } from 'react'
import { Button, Input, Modal, Empty } from '../ui'
import { IconPlus, IconDelete } from '../ui/Icons'
import { useLocale } from '../i18n'
import type { BrowserBackendKind, CaptureMode, CreateSessionOptions, Session } from '../../shared/types'
import styles from './SessionList.module.css'

declare const __AA_BUILD_CHANNEL__: 'public' | 'internal'
const cloakBuildAvailable = typeof __AA_BUILD_CHANNEL__ !== 'undefined' && __AA_BUILD_CHANNEL__ === 'internal'

interface SessionListProps {
  sessions: Session[]
  currentSessionId: string | null
  onSelect: (id: string) => void
  onCreate: (name: string, url: string, options?: CreateSessionOptions) => Promise<void>
  onDelete: (id: string, retainProfile?: boolean) => Promise<void>
  onOpenSettings: () => void
  onModalVisibilityChange?: (open: boolean) => void
  activeRequestCount?: number
  /** Incrementing counter to trigger open-create-modal from outside */
  createTrigger?: number
}

/**
 * Session status dot color
 */
function getDotColor(session: Session): string {
  if (session.status === 'running') return 'var(--color-success)'
  if (session.status === 'paused') return 'var(--color-warning)'
  return 'var(--text-disabled)'
}

function getStatusInfo(session: Session): { symbol: string; color: string; labelKey: string } {
  if (session.status === 'running') return { symbol: '●', color: 'var(--color-success)', labelKey: 'capture.running' }
  if (session.status === 'paused') return { symbol: '⏸', color: 'var(--color-warning)', labelKey: 'capture.paused' }
  return { symbol: '■', color: 'var(--text-muted)', labelKey: 'capture.stopped' }
}

function extractDomain(url: string): string {
  if (!url) return ''
  try { return new URL(url).hostname } catch { return url }
}

const SessionList: React.FC<SessionListProps> = ({
  sessions,
  currentSessionId,
  onSelect,
  onCreate,
  onDelete,
  onOpenSettings,
  onModalVisibilityChange,
  activeRequestCount = 0,
  createTrigger = 0,
}) => {
  const { t } = useLocale()
  const [modalOpen, setModalOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<Session | null>(null)
  const [retainProfile, setRetainProfile] = useState(false)

  const [formName, setFormName] = useState('')
  const [formUrl, setFormUrl] = useState('')
  const [backend, setBackend] = useState<BrowserBackendKind>('electron')
  const [captureMode, setCaptureMode] = useState<CaptureMode>('deep')
  const [nameError, setNameError] = useState('')
  const [urlError, setUrlError] = useState('')
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    window.electronAPI.getAppVersion().then(v => setAppVersion(v))
  }, [])

  const openModal = () => {
    onModalVisibilityChange?.(true)
    setModalOpen(true)
  }

  // Open create modal when triggered externally
  useEffect(() => {
    if (createTrigger > 0) openModal()
  }, [createTrigger]) // eslint-disable-line react-hooks/exhaustive-deps

  const closeModal = () => {
    setModalOpen(false)
    onModalVisibilityChange?.(false)
    setFormName('')
    setFormUrl('')
    setBackend('electron')
    setCaptureMode('deep')
    setNameError('')
    setUrlError('')
  }

  const validate = (): boolean => {
    let valid = true
    if (!formName.trim()) {
      setNameError('Please enter a session name')
      valid = false
    } else {
      setNameError('')
    }
    if (formUrl.trim()) {
      try {
        new URL(formUrl)
        setUrlError('')
      } catch {
        setUrlError('Please enter a valid URL')
        valid = false
      }
    } else {
      setUrlError('')
    }
    return valid
  }

  const handleCreate = async () => {
    if (!validate()) return
    setCreating(true)
    try {
      await onCreate(formName.trim(), formUrl.trim(), { backend, captureMode })
      closeModal()
    } catch {
      // create failed
    } finally {
      setCreating(false)
    }
  }

  const requestDelete = (e: React.MouseEvent, session: Session) => {
    e.stopPropagation()
    onModalVisibilityChange?.(true)
    setRetainProfile(false)
    setDeleteCandidate(session)
  }

  const closeDeleteModal = () => {
    setDeleteCandidate(null)
    onModalVisibilityChange?.(false)
  }

  const handleDelete = async () => {
    if (!deleteCandidate) return
    const id = deleteCandidate.id
    setDeletingId(id)
    try {
      await onDelete(id, deleteCandidate.browser_backend === 'cloak' && retainProfile)
      closeDeleteModal()
    } catch {
      // delete failed
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className={styles.container}>
      {/* Section header with count */}
      <div className={styles.sectionHeader}>
        <span className={styles.sectionLabel}>SESSIONS</span>
        {sessions.length > 0 && (
          <span className={styles.sectionCount}>{sessions.length}</span>
        )}
      </div>

      {/* Session list */}
      <div className={styles.list}>
        {sessions.length === 0 ? (
          <Empty description="No sessions" style={{ marginTop: 40 }} />
        ) : (
          sessions.map((session) => {
            const isActive = session.id === currentSessionId
            const isHovered = session.id === hoveredId
            const dotColor = getDotColor(session)
            const status = getStatusInfo(session)
            const domain = extractDomain(session.target_url)
            return (
              <div
                key={session.id}
                className={`${styles.item} ${isActive ? styles.itemActive : ''}`}
                onClick={() => onSelect(session.id)}
                onMouseEnter={() => setHoveredId(session.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <div
                  className={`${styles.statusDot} ${session.status === 'running' ? styles.statusDotRunning : ''}`}
                  style={{ background: dotColor, color: dotColor }}
                />
                <div className={styles.sessionInfo}>
                  <div className={styles.sessionName}>{session.name}</div>
                  <div className={styles.sessionMeta}>
                    <span style={{ color: status.color }}>{status.symbol} {t(status.labelKey as any)}</span>
                    <span className={styles.backendBadge}>
                      {session.browser_backend === 'cloak' ? 'Cloak' : 'Electron'} · {session.capture_mode === 'passive' ? 'Passive' : 'Deep'}
                    </span>
                    {isActive && activeRequestCount > 0 && (
                      <span className={styles.sessionCount}> · {activeRequestCount} reqs</span>
                    )}
                  </div>
                  {domain && <div className={styles.sessionUrl}>{domain}</div>}
                </div>

                {isHovered && (
                  <span
                    className={`${styles.deleteBtn} ${deletingId === session.id ? styles.deleteBtnDisabled : ''}`}
                    onClick={(e) => requestDelete(e, session)}
                  >
                    <IconDelete size={13} />
                  </span>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* New session button */}
      <div className={styles.footer}>
        <div className={styles.newBtn} onClick={openModal}>
          + {t('session.newSession').replace('+ ', '')}
        </div>
      </div>

      {/* Bottom: Settings + Version */}
      <div className={styles.sidebarBottom}>
        <div className={styles.bottomBtn} onClick={onOpenSettings}>⚙ {t('settings.title')}</div>
        <div className={styles.versionText}>v{appVersion}</div>
      </div>

      {/* Create session modal */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={t('session.createTitle')}
        footer={
          <>
            <Button onClick={closeModal}>{t('session.cancel')}</Button>
            <Button variant="primary" onClick={handleCreate} loading={creating}>
              {t('session.create')}
            </Button>
          </>
        }
      >
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{t('session.name')}</label>
          <Input
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder={t('session.namePlaceholder')}
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          {nameError && <div className={styles.formError}>{nameError}</div>}
        </div>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>Browser backend</label>
          <div className={styles.segmented}>
            <button
              type="button"
              className={backend === 'electron' ? styles.segmentActive : ''}
              onClick={() => { setBackend('electron'); setCaptureMode('deep') }}
            >Electron</button>
            <button
              type="button"
              disabled={!cloakBuildAvailable}
              title={cloakBuildAvailable ? 'Open CloakBrowser in a separate window' : 'Available in Internal builds only'}
              className={backend === 'cloak' ? styles.segmentActive : ''}
              onClick={() => { setBackend('cloak'); setCaptureMode('passive') }}
            >Cloak</button>
          </div>
          {!cloakBuildAvailable && <div className={styles.formHint}>Cloak is available only in Internal builds.</div>}
        </div>
        {backend === 'cloak' && (
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Capture mode</label>
            <div className={styles.segmented}>
              <button type="button" className={captureMode === 'passive' ? styles.segmentActive : ''} onClick={() => setCaptureMode('passive')}>Passive</button>
              <button type="button" className={captureMode === 'deep' ? styles.segmentActive : ''} onClick={() => setCaptureMode('deep')}>Deep</button>
            </div>
            <div className={styles.formHint}>
              {captureMode === 'passive'
                ? 'CDP network capture without page hooks. Interaction recording is disabled.'
                : 'Enables page hooks and interaction recording; sites may detect the instrumentation.'}
            </div>
          </div>
        )}
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{t('session.targetUrl')}</label>
          <Input
            value={formUrl}
            onChange={(e) => setFormUrl(e.target.value)}
            placeholder={t('session.targetUrlPlaceholder')}
          />
          <div className={styles.formHint}>Leave empty to capture traffic via proxy only</div>
          {urlError && <div className={styles.formError}>{urlError}</div>}
        </div>
      </Modal>

      <Modal
        open={deleteCandidate !== null}
        onClose={closeDeleteModal}
        title="Delete session"
        footer={
          <>
            <Button onClick={closeDeleteModal}>Cancel</Button>
            <Button variant="danger" loading={deletingId !== null} onClick={handleDelete}>Delete</Button>
          </>
        }
      >
        <div className={styles.deleteText}>
          Delete <strong>{deleteCandidate?.name}</strong> and all captured data? This cannot be undone.
        </div>
        {deleteCandidate?.browser_backend === 'cloak' && (
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={retainProfile}
              onChange={(event) => setRetainProfile(event.target.checked)}
            />
            <span>Keep the Cloak profile, login state, and tabs for later recovery</span>
          </label>
        )}
      </Modal>
    </div>
  )
}

export default SessionList
