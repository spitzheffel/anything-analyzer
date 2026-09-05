import { useEffect, useState } from 'react'
import { Button, Input, InputNumber, Select, useToast } from '../../ui'
import { useLocale } from '../../i18n'
import type { BrowserBackendKind, FingerprintProfile } from '@shared/types'

interface Props {
  currentSessionId?: string | null
  backend?: BrowserBackendKind
}

export default function FingerprintSection({ currentSessionId, backend = 'electron' }: Props) {
  const toast = useToast()
  const { t } = useLocale()
  const [profile, setProfile] = useState<FingerprintProfile | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!currentSessionId || backend === 'cloak') { setProfile(null); return }
    window.electronAPI.getFingerprintProfile(currentSessionId).then(p => {
      setProfile(p)
    })
  }, [currentSessionId, backend])

  if (backend === 'cloak') {
    return (
      <div style={{ color: 'var(--text-muted)', padding: 20, lineHeight: 1.6 }}>
        CloakBrowser owns the complete fingerprint profile for this session. Anything Analyzer does not apply its Electron stealth scripts or header overrides.
      </div>
    )
  }

  if (!currentSessionId) {
    return (
      <div style={{ color: 'var(--text-muted)', padding: 20, textAlign: 'center' }}>
        {t('fingerprint.noSession')}
      </div>
    )
  }

  if (!profile) return null

  const update = (partial: Partial<FingerprintProfile>) => {
    setProfile(prev => prev ? { ...prev, ...partial } : prev)
  }

  const handleSave = async () => {
    if (!profile) return
    await window.electronAPI.updateFingerprintProfile(profile)
    toast.success(t('fingerprint.saved'))
  }

  const handleRegenerate = async () => {
    if (!currentSessionId) return
    const newProfile = await window.electronAPI.regenerateFingerprintProfile(currentSessionId)
    setProfile(newProfile)
    toast.success(t('fingerprint.regenerated'))
  }

  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  }
  const labelStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-base)', minWidth: 100, flexShrink: 0,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
      {/* Summary */}
      <div style={{
        padding: '8px 12px',
        background: 'var(--color-surface)',
        borderRadius: 6,
        fontSize: 'var(--font-size-sm)',
        fontFamily: 'var(--font-mono)',
        lineHeight: 1.6,
        color: 'var(--text-secondary)',
      }}>
        <div>{profile.platform} · Chrome/{profile.userAgent.match(/Chrome\/(\S+)/)?.[1]}</div>
        <div>{profile.screenWidth}x{profile.screenHeight} @{profile.devicePixelRatio}x · {profile.hardwareConcurrency} cores · {profile.deviceMemory}GB</div>
        <div>{profile.timezone} · {profile.languages.join(', ')}</div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" onClick={handleRegenerate}>{t('fingerprint.regenerate')}</Button>
        <Button onClick={handleSave}>{t('fingerprint.save')}</Button>
      </div>

      {/* Expandable details */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          cursor: 'pointer',
          fontSize: 'var(--font-size-sm)',
          color: 'var(--text-muted)',
          userSelect: 'none',
        }}
      >
        {expanded ? '▼' : '▶'} {t('fingerprint.detail')}
      </div>

      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('fingerprint.ua')}</span>
            <Input
              value={profile.userAgent}
              onChange={e => update({ userAgent: e.target.value })}
              style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-2xs)' }}
            />
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('fingerprint.platform')}</span>
            <Select
              value={profile.platform}
              onChange={v => update({ platform: v })}
              style={{ width: 180 }}
              options={[
                { label: 'Windows', value: 'Win32' },
                { label: 'macOS', value: 'MacIntel' },
                { label: 'Linux', value: 'Linux x86_64' },
              ]}
            />
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('fingerprint.screen')}</span>
            <InputNumber value={profile.screenWidth} onChange={v => v !== null && update({ screenWidth: v })} style={{ width: 80 }} />
            <span>x</span>
            <InputNumber value={profile.screenHeight} onChange={v => v !== null && update({ screenHeight: v })} style={{ width: 80 }} />
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('fingerprint.dpr')}</span>
            <InputNumber value={profile.devicePixelRatio} min={1} max={3} step={0.25} onChange={v => v !== null && update({ devicePixelRatio: v })} style={{ width: 80 }} />
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('fingerprint.cpu')}</span>
            <InputNumber value={profile.hardwareConcurrency} min={1} max={32} onChange={v => v !== null && update({ hardwareConcurrency: v })} style={{ width: 80 }} />
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('fingerprint.memory')}</span>
            <InputNumber value={profile.deviceMemory} min={2} max={64} onChange={v => v !== null && update({ deviceMemory: v })} style={{ width: 80 }} />
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('fingerprint.webgl')}</span>
            <Input
              value={profile.webglRenderer}
              onChange={e => update({ webglRenderer: e.target.value })}
              style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-2xs)' }}
            />
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('fingerprint.timezone')}</span>
            <Input value={profile.timezone} onChange={e => update({ timezone: e.target.value })} style={{ width: 200 }} />
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('fingerprint.languages')}</span>
            <Input
              value={profile.languages.join(', ')}
              onChange={e => update({ languages: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
              style={{ flex: 1 }}
            />
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('fingerprint.webrtc')}</span>
            <Select
              value={profile.webrtcPolicy}
              onChange={v => update({ webrtcPolicy: v as 'block' | 'real' | 'fake' })}
              style={{ width: 120 }}
              options={[
                { label: 'Block', value: 'block' },
                { label: 'Real', value: 'real' },
                { label: 'Fake', value: 'fake' },
              ]}
            />
          </div>
        </div>
      )}

      {/* Test links */}
      <div style={{ marginTop: 4 }}>
        <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
          {t('fingerprint.testLinks')}:
        </span>
        <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
          {[
            { label: 'BrowserLeaks', url: 'https://browserleaks.com/javascript' },
            { label: 'CreepJS', url: 'https://abrahamjuliot.github.io/creepjs/' },
            { label: 'Bot Detect', url: 'https://bot.sannysoft.com/' },
          ].map(link => (
            <span
              key={link.url}
              onClick={() => window.electronAPI.openExternal(link.url)}
              style={{
                fontSize: 'var(--font-size-sm)',
                color: 'var(--color-accent)',
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              {link.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
