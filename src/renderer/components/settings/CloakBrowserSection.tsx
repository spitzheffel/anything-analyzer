import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, CopyableBlock, Popconfirm, Progress, Tag, useToast } from '../../ui'
import {
  IconCheckCircle,
  IconCloudDownload,
  IconDelete,
  IconLoading,
  IconReload,
} from '../../ui/Icons'
import type {
  BrowserProfile,
  CloakRuntimePolicy,
  CloakRuntimeState,
  CloakRuntimeStatus,
  Session,
} from '@shared/types'
import styles from './CloakBrowserSection.module.css'

const LOGIN_COMMAND = 'npx cloakbrowser login'

const statePresentation: Record<
  CloakRuntimeState,
  { label: string; color: string; tag: 'default' | 'success' | 'warning' | 'error' | 'info' }
> = {
  unavailable: { label: '当前构建不可用', color: 'var(--text-muted)', tag: 'default' },
  checking: { label: '正在检测', color: 'var(--color-info)', tag: 'info' },
  'login-required': { label: '需要登录', color: 'var(--color-warning)', tag: 'warning' },
  'not-installed': { label: '尚未安装', color: 'var(--color-warning)', tag: 'warning' },
  downloading: { label: '正在下载', color: 'var(--color-info)', tag: 'info' },
  ready: { label: '已就绪', color: 'var(--color-success)', tag: 'success' },
  error: { label: '运行时异常', color: 'var(--color-error)', tag: 'error' },
}

const profileStatePresentation: Record<
  BrowserProfile['state'],
  { label: string; tag: 'default' | 'warning' | 'error' | 'info' }
> = {
  attached: { label: '使用中', tag: 'info' },
  retained: { label: '已保留', tag: 'default' },
  deleting: { label: '删除中', tag: 'warning' },
  delete_failed: { label: '删除失败', tag: 'error' },
  missing: { label: '目录缺失', tag: 'error' },
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatBytes(bytes?: number): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function formatProfileTime(profile: BrowserProfile): string {
  const timestamp = profile.retained_at ?? profile.last_used_at ?? profile.updated_at
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

interface CloakBrowserSectionProps {
  onProfileRestored?: (session: Session) => void | Promise<void>
}

export default function CloakBrowserSection({ onProfileRestored }: CloakBrowserSectionProps) {
  const toast = useToast()
  const mountedRef = useRef(true)
  const [status, setStatus] = useState<CloakRuntimeStatus | null>(null)
  const [profiles, setProfiles] = useState<BrowserProfile[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [policyBusy, setPolicyBusy] = useState(false)
  const [profileAction, setProfileAction] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true)
    try {
      const nextStatus = await window.electronAPI.getCloakStatus()
      if (mountedRef.current) {
        setStatus(nextStatus)
        setLoadError(null)
      }
      return nextStatus
    } catch (error) {
      if (mountedRef.current && !quiet) setLoadError(errorMessage(error))
      return null
    } finally {
      if (mountedRef.current && !quiet) setRefreshing(false)
    }
  }, [])

  const loadProfiles = useCallback(async () => {
    try {
      const nextProfiles = await window.electronAPI.listRetainedBrowserProfiles()
      if (mountedRef.current) setProfiles(nextProfiles)
    } catch (error) {
      if (mountedRef.current) setLoadError(errorMessage(error))
    }
  }, [])

  const refreshAll = useCallback(async () => {
    await Promise.all([loadStatus(), loadProfiles()])
  }, [loadProfiles, loadStatus])

  useEffect(() => {
    mountedRef.current = true
    void refreshAll()
    return () => {
      mountedRef.current = false
    }
  }, [refreshAll])

  useEffect(() => {
    if (!preparing && status?.state !== 'downloading' && status?.state !== 'checking') return
    const timer = window.setInterval(() => void loadStatus(true), 700)
    return () => window.clearInterval(timer)
  }, [loadStatus, preparing, status?.state])

  const handlePolicyChange = async (policy: CloakRuntimePolicy) => {
    if (!status || status.policy === policy || policyBusy) return
    setPolicyBusy(true)
    try {
      await window.electronAPI.setCloakRuntimePolicy(policy)
      await loadStatus()
      toast.success('CloakBrowser 版本策略已保存')
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      if (mountedRef.current) setPolicyBusy(false)
    }
  }

  const handlePrepare = async () => {
    if (!status || preparing) return
    setPreparing(true)
    setLoadError(null)
    try {
      await window.electronAPI.prepareCloakRuntime(status.policy)
      await loadStatus()
      toast.success('CloakBrowser 运行时已就绪')
    } catch (error) {
      const message = errorMessage(error)
      setLoadError(message)
      toast.error(message)
    } finally {
      if (mountedRef.current) setPreparing(false)
    }
  }

  const handleRestore = async (profileId: string) => {
    setProfileAction(`restore:${profileId}`)
    try {
      const restoredSession = await window.electronAPI.restoreBrowserProfile(profileId)
      await onProfileRestored?.(restoredSession)
      await loadProfiles()
      toast.success('Profile 已恢复')
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      if (mountedRef.current) setProfileAction(null)
    }
  }

  const handleDelete = async (profileId: string) => {
    setProfileAction(`delete:${profileId}`)
    try {
      await window.electronAPI.deleteBrowserProfile(profileId)
      await loadProfiles()
      toast.success('Profile 已永久删除')
    } catch (error) {
      toast.error(errorMessage(error))
      await loadProfiles()
    } finally {
      if (mountedRef.current) setProfileAction(null)
    }
  }

  const presentation = statePresentation[status?.state ?? 'checking']
  const isUnavailable = status?.available === false || status?.state === 'unavailable'
  const progress = status?.downloadProgress
  const received = formatBytes(progress?.receivedBytes)
  const total = formatBytes(progress?.totalBytes)

  return (
    <div className={styles.root}>
      <section className={styles.section} aria-labelledby="cloak-runtime-heading">
        <div className={styles.sectionHeader}>
          <div>
            <h2 id="cloak-runtime-heading" className={styles.heading}>CloakBrowser 运行时</h2>
            <p className={styles.subheading}>检测登录状态、浏览器版本与本地运行时。</p>
          </div>
          <div className={styles.headerActions}>
            <span className={styles.statusLine}>
              <span className={styles.statusDot} style={{ background: presentation.color }} />
              {presentation.label}
            </span>
            <Button
              size="sm"
              icon={<IconReload size={13} />}
              loading={refreshing}
              onClick={() => void refreshAll()}
            >
              重新检测
            </Button>
          </div>
        </div>

        {(loadError || status?.error) && (
          <div className={styles.errorBanner} role="alert">
            {loadError ?? status?.error}
          </div>
        )}

        {isUnavailable ? (
          <div className={styles.mutedBanner}>此安装包未包含 CloakBrowser 运行时。</div>
        ) : (
          <>
            <div className={styles.runtimeFacts}>
              <div className={styles.fact}>
                <span className={styles.factLabel}>账户</span>
                <span className={styles.factValue}>
                  {status?.loggedIn ? (
                    <><IconCheckCircle size={13} className={styles.successIcon} />已登录</>
                  ) : '未登录'}
                </span>
              </div>
              <div className={styles.fact}>
                <span className={styles.factLabel}>计划</span>
                <span className={styles.factValue}>{status?.plan ?? '--'}</span>
              </div>
              <div className={styles.fact}>
                <span className={styles.factLabel}>席位</span>
                <span className={styles.factValue}>{status?.loggedIn ? status.seats : '--'}</span>
              </div>
              <div className={styles.fact}>
                <span className={styles.factLabel}>目标版本</span>
                <code className={styles.version}>{status?.configuredVersion ?? 'latest'}</code>
              </div>
              <div className={styles.fact}>
                <span className={styles.factLabel}>本地版本</span>
                <code className={styles.version}>{status?.actualVersion ?? '未安装'}</code>
              </div>
            </div>

            {!status?.loggedIn && (
              <div className={styles.loginBlock}>
                <div className={styles.inlineHeading}>登录 CloakBrowser</div>
                <p className={styles.inlineHint}>在终端运行命令并完成登录，然后重新检测。</p>
                <CopyableBlock content={LOGIN_COMMAND} maxHeight={56} />
              </div>
            )}
          </>
        )}
      </section>

      <section className={styles.section} aria-labelledby="cloak-policy-heading">
        <div className={styles.compactHeader}>
          <div>
            <h2 id="cloak-policy-heading" className={styles.heading}>版本策略</h2>
            <p className={styles.subheading}>新会话按所选策略解析浏览器版本。</p>
          </div>
          {status && <Tag color={presentation.tag}>{presentation.label}</Tag>}
        </div>

        <div className={styles.policyControl} role="radiogroup" aria-label="CloakBrowser 版本策略">
          <button
            type="button"
            role="radio"
            aria-checked={status?.policy === 'strict'}
            className={`${styles.policyOption} ${status?.policy === 'strict' ? styles.policyOptionActive : ''}`}
            disabled={!status || isUnavailable || policyBusy}
            onClick={() => void handlePolicyChange('strict')}
          >
            <span className={styles.policyTitle}>Strict</span>
            <span className={styles.policyDetail}>固定兼容版本</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={status?.policy === 'free-latest'}
            className={`${styles.policyOption} ${status?.policy === 'free-latest' ? styles.policyOptionActive : ''}`}
            disabled={!status || isUnavailable || policyBusy}
            onClick={() => void handlePolicyChange('free-latest')}
          >
            <span className={styles.policyTitle}>Free latest</span>
            <span className={styles.policyDetail}>跟随免费最新版</span>
          </button>
        </div>

        {status?.policy === 'free-latest' && (
          <div className={styles.warningBanner} role="status">
            Free latest 会随 CloakBrowser 更新更换内核。Context 下次重建时实际版本可能变化，
            升级后需重新执行浏览器契约测试；本次实际版本会记录到 Session。
          </div>
        )}

        {progress && (status?.state === 'downloading' || preparing) && (
          <div className={styles.downloadProgress}>
            {progress.totalBytes == null && progress.receivedBytes == null ? (
              <span className={styles.progressMeta} role="status">
                <IconLoading size={13} /> CloakBrowser 正在下载，当前 wrapper 未提供字节进度
              </span>
            ) : (
              <Progress percent={progress.percent} showPercent />
            )}
            {(received || total) && (
              <span className={styles.progressMeta}>{received ?? '0 B'}{total ? ` / ${total}` : ''}</span>
            )}
          </div>
        )}

        <div className={styles.actionRow}>
          <Button
            variant="primary"
            icon={preparing || status?.state === 'downloading'
              ? <IconLoading size={14} />
              : <IconCloudDownload size={14} />}
            loading={preparing}
            disabled={!status || isUnavailable || status.state === 'checking' || status.state === 'login-required' || status.state === 'ready'}
            onClick={() => void handlePrepare()}
          >
            {status?.state === 'ready' ? '运行时已就绪' : '按需下载并准备'}
          </Button>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="retained-profiles-heading">
        <div className={styles.compactHeader}>
          <div>
            <h2 id="retained-profiles-heading" className={styles.heading}>保留的 Profile</h2>
            <p className={styles.subheading}>恢复登录状态和标签页，或永久删除本地数据。</p>
          </div>
          <span className={styles.count}>{profiles.length}</span>
        </div>

        {profiles.length === 0 ? (
          <div className={styles.empty}>暂无保留的 Profile</div>
        ) : (
          <div className={styles.profileList}>
            {profiles.map(profile => {
              const profilePresentation = profileStatePresentation[profile.state]
              const restoring = profileAction === `restore:${profile.id}`
              const deleting = profileAction === `delete:${profile.id}`
              return (
                <div className={styles.profileRow} key={profile.id}>
                  <div className={styles.profileMain}>
                    <div className={styles.profileTitleRow}>
                      <span className={styles.profileName}>{profile.display_name}</span>
                      <Tag color={profilePresentation.tag}>{profilePresentation.label}</Tag>
                    </div>
                    <div className={styles.profileMeta}>
                      <span>{formatProfileTime(profile)}</span>
                      <code>{profile.profile_key}</code>
                    </div>
                    {profile.last_error && <div className={styles.profileError}>{profile.last_error}</div>}
                  </div>
                  <div className={styles.profileActions}>
                    <Button
                      size="sm"
                      loading={restoring}
                      disabled={profileAction !== null || profile.state !== 'retained'}
                      onClick={() => void handleRestore(profile.id)}
                    >
                      恢复
                    </Button>
                    <Popconfirm
                      align="end"
                      title={`永久删除 ${profile.display_name} 及其登录状态？`}
                      okText="永久删除"
                      cancelText="取消"
                      onConfirm={() => void handleDelete(profile.id)}
                    >
                      <Button
                        variant="danger"
                        size="sm"
                        iconOnly
                        icon={<IconDelete size={13} />}
                        loading={deleting}
                        disabled={profileAction !== null || profile.state === 'deleting'}
                        title="永久删除 Profile"
                        aria-label={`永久删除 ${profile.display_name}`}
                      />
                    </Popconfirm>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
