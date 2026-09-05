import React, { useEffect, useState } from 'react'
import { Modal } from '../ui'
import { IconApp, IconRobot, IconGlobe, IconBolt, IconShield, IconCode } from '../ui/Icons'
import GeneralSection from './settings/GeneralSection'
import LLMSection from './settings/LLMSection'
import ProxySection from './settings/ProxySection'
import MCPServerSection from './settings/MCPServerSection'
import MitmProxySection from './settings/MitmProxySection'
import FingerprintSection from './settings/FingerprintSection'
import CloakBrowserSection from './settings/CloakBrowserSection'
import type { BrowserBackendKind } from '@shared/types'

declare const __AA_BUILD_CHANNEL__: 'public' | 'internal'
const cloakBuildAvailable =
  typeof __AA_BUILD_CHANNEL__ !== 'undefined' &&
  __AA_BUILD_CHANNEL__ === 'internal'

type SettingsSection = 'general' | 'llm' | 'proxy' | 'mcp-server' | 'mitm-proxy' | 'fingerprint' | 'cloak'

const menuItems: { key: SettingsSection; icon: React.FC<{ size?: number | string }>; label: string }[] = [
  { key: 'general', icon: IconApp, label: '通用' },
  { key: 'llm', icon: IconRobot, label: 'LLM' },
  { key: 'proxy', icon: IconGlobe, label: '代理' },
  { key: 'mcp-server', icon: IconBolt, label: 'MCP Server' },
  { key: 'mitm-proxy', icon: IconShield, label: 'MITM 代理' },
  { key: 'fingerprint', icon: IconCode, label: '指纹' },
  ...(cloakBuildAvailable
    ? [{ key: 'cloak' as const, icon: IconGlobe, label: 'CloakBrowser' }]
    : []),
]

const sectionComponents: Record<SettingsSection, React.ComponentType> = {
  'general': GeneralSection,
  'llm': LLMSection,
  'proxy': ProxySection,
  'mcp-server': MCPServerSection,
  'mitm-proxy': MitmProxySection,
  'fingerprint': FingerprintSection as React.ComponentType,
  'cloak': CloakBrowserSection as React.ComponentType,
}

interface Props {
  open: boolean
  onClose: () => void
  currentSessionId?: string | null
  currentSessionBackend?: BrowserBackendKind
  onProfileRestored?: () => void | Promise<void>
}

export default function SettingsModal({
  open,
  onClose,
  currentSessionId,
  currentSessionBackend,
  onProfileRestored,
}: Props) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('general')
  const visibleMenuItems = currentSessionBackend === 'cloak'
    ? menuItems.filter(item => item.key !== 'fingerprint')
    : menuItems

  useEffect(() => {
    if (currentSessionBackend === 'cloak' && activeSection === 'fingerprint') {
      setActiveSection('general')
    }
  }, [activeSection, currentSessionBackend])

  const ActiveComponent = sectionComponents[activeSection]

  return (
    <Modal
      title="Settings"
      open={open}
      onClose={onClose}
      width={900}
    >
      {/* Negate modal body padding so sidebar border runs edge-to-edge */}
      <div style={{ margin: '-16px -24px', display: 'flex', height: 560, overflow: 'hidden' }}>
        {/* Left sidebar navigation */}
        <div style={{
          width: 180,
          borderRight: '1px solid var(--color-border)',
          paddingTop: 12,
          paddingBottom: 12,
          flexShrink: 0,
          overflow: 'auto',
        }}>
          {visibleMenuItems.map(item => {
            const Icon = item.icon
            const isActive = activeSection === item.key
            return (
              <div
                key={item.key}
                onClick={() => setActiveSection(item.key)}
                style={{
                  padding: '8px 16px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  borderRadius: 6,
                  margin: '2px 8px',
                  fontSize: 'var(--font-size-base)',
                  background: isActive ? 'var(--color-accent-bg)' : 'transparent',
                  color: isActive ? 'var(--color-accent)' : 'var(--text-secondary)',
                  transition: 'background 0.2s',
                }}
                onMouseEnter={e => {
                  if (!isActive) (e.currentTarget.style.background = 'var(--color-hover)')
                }}
                onMouseLeave={e => {
                  if (!isActive) (e.currentTarget.style.background = 'transparent')
                }}
              >
                <Icon size={16} />
                <span style={{ color: 'inherit', fontSize: 'inherit' }}>{item.label}</span>
              </div>
            )
          })}
        </div>

        {/* Right content area */}
        <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
          {activeSection === 'fingerprint' ? (
            <FingerprintSection
              currentSessionId={currentSessionId}
              backend={currentSessionBackend}
            />
          ) : activeSection === 'cloak' ? (
            <CloakBrowserSection onProfileRestored={onProfileRestored} />
          ) : (
            <ActiveComponent />
          )}
        </div>
      </div>
    </Modal>
  )
}
