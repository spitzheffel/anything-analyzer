import React, { useState, useEffect, useCallback, useRef } from 'react'
import { IconMinimize, IconMaximize, IconClose, IconGlobe, IconCode, IconRobot } from '../ui/Icons'
import { useLocale } from '../i18n'
import type { LocaleKey } from '../i18n'
import { THEMES } from '../theme'
import styles from './Titlebar.module.css'

export type AppView = 'browser' | 'inspector' | 'report'

interface TitlebarProps {
  theme: string
  onThemeChange: (themeId: string) => void
  locale: 'en' | 'zh'
  onLocaleToggle: () => void
  activeView: AppView
  onViewChange: (view: AppView) => void
  onOverlayVisibilityChange?: (open: boolean) => void
  requestCount?: number
}

const navTabs: { key: AppView; labelKey: LocaleKey; icon: React.ReactNode }[] = [
  { key: 'browser', labelKey: 'nav.browser', icon: <IconGlobe size={13} /> },
  { key: 'inspector', labelKey: 'nav.inspector', icon: <IconCode size={13} /> },
  { key: 'report', labelKey: 'nav.report', icon: <IconRobot size={13} /> },
]

const Titlebar: React.FC<TitlebarProps> = ({
  theme,
  onThemeChange,
  locale,
  onLocaleToggle,
  activeView,
  onViewChange,
  onOverlayVisibilityChange,
  requestCount = 0,
}) => {
  const { t } = useLocale()
  const [isMaximized, setIsMaximized] = useState(false)
  const [themeOpen, setThemeOpen] = useState(false)
  const themeRef = useRef<HTMLDivElement>(null)

  const setThemePopoverOpen = useCallback((open: boolean) => {
    setThemeOpen(open)
    onOverlayVisibilityChange?.(open)
  }, [onOverlayVisibilityChange])

  useEffect(() => {
    window.electronAPI.isWindowMaximized().then(setIsMaximized)
  }, [])

  // Close theme popover on outside click
  useEffect(() => {
    if (!themeOpen) return
    const handleClick = (e: MouseEvent) => {
      if (themeRef.current && !themeRef.current.contains(e.target as Node)) {
        setThemePopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [themeOpen, setThemePopoverOpen])

  const handleMinimize = useCallback(() => {
    window.electronAPI.minimizeWindow()
  }, [])

  const handleMaximize = useCallback(async () => {
    await window.electronAPI.maximizeWindow()
    const maximized = await window.electronAPI.isWindowMaximized()
    setIsMaximized(maximized)
  }, [])

  const handleClose = useCallback(() => {
    window.electronAPI.closeWindow()
  }, [])

  const currentTheme = THEMES.find(t => t.id === theme)

  return (
    <div className={styles.titlebar}>
      {/* Logo area — matches sidebar width */}
      <div className={styles.logoArea}>
        <div className={styles.logoIcon}>A</div>
        <span className={styles.logoText}>Anything Analyzer</span>
      </div>

      {/* Navigation Tabs */}
      <div className={styles.tabs}>
        {navTabs.map((tab) => (
          <button
            key={tab.key}
            className={`${styles.tab} ${activeView === tab.key ? styles.tabActive : ''}`}
            onClick={() => onViewChange(tab.key)}
          >
            <span className={styles.tabIcon}>{tab.icon}</span>
            {t(tab.labelKey)}
            {tab.key === 'inspector' && requestCount > 0 && (
              <span className={styles.tabBadge}>{requestCount}</span>
            )}
          </button>
        ))}
      </div>

      {/* Draggable spacer */}
      <div className={styles.spacer} />

      {/* Right controls */}
      <div className={styles.rightControls}>
        {/* Language toggle */}
        <button className={styles.langSwitch} onClick={onLocaleToggle}>
          <span className={locale === 'zh' ? styles.langActive : ''}>中</span>
          {' / '}
          <span className={locale === 'en' ? styles.langActive : ''}>En</span>
        </button>

        {/* Theme selector */}
        <div ref={themeRef} style={{ position: 'relative' }}>
          <button
            className={styles.actionBtn}
            onClick={() => setThemePopoverOpen(!themeOpen)}
            title={locale === 'zh' ? '切换主题' : 'Switch theme'}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: currentTheme?.accent || '#60a5fa',
                display: 'inline-block',
                border: '1px solid var(--color-border-hover)',
              }}
            />
          </button>

          {themeOpen && (
            <div className={styles.themePopover}>
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={`${styles.themeItem} ${theme === t.id ? styles.themeItemActive : ''}`}
                  onClick={() => { onThemeChange(t.id); setThemePopoverOpen(false) }}
                >
                  <span
                    className={styles.themeDot}
                    style={{ background: t.accent }}
                  />
                  <span className={styles.themeName}>
                    {locale === 'zh' ? t.name : t.nameEn}
                  </span>
                  {theme === t.id && <span className={styles.themeCheck}>✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className={styles.separator} />
      </div>

      {/* Window controls */}
      <div className={styles.windowControls}>
        <button className={styles.windowBtn} onClick={handleMinimize}>
          <IconMinimize size={12} />
        </button>
        <button className={styles.windowBtn} onClick={handleMaximize}>
          <IconMaximize size={12} />
        </button>
        <button className={`${styles.windowBtn} ${styles.windowBtnClose}`} onClick={handleClose}>
          <IconClose size={12} />
        </button>
      </div>
    </div>
  )
}

export default Titlebar
