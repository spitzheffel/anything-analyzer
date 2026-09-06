import React, { useState } from 'react'
import styles from './Collapse.module.css'

export interface CollapseItem {
  key: string
  label: React.ReactNode
  children: React.ReactNode
}

export interface CollapseProps {
  items: CollapseItem[]
  defaultActiveKey?: string[]
  /** 受控模式：传入后由外部决定展开项 */
  activeKey?: string[]
  onChange?: (activeKeys: string[]) => void
  className?: string
}

export const Collapse: React.FC<CollapseProps> = ({ items, defaultActiveKey = [], activeKey, onChange, className }) => {
  const [internalKeys, setInternalKeys] = useState<Set<string>>(new Set(defaultActiveKey))
  const isControlled = activeKey !== undefined
  const activeKeys = isControlled ? new Set(activeKey) : internalKeys

  const toggle = (key: string) => {
    const next = new Set(activeKeys)
    if (next.has(key)) {
      next.delete(key)
    } else {
      next.add(key)
    }
    if (!isControlled) setInternalKeys(next)
    onChange?.([...next])
  }

  return (
    <div className={`${styles.collapse} ${className ?? ''}`}>
      {items.map((item) => {
        const isOpen = activeKeys.has(item.key)
        return (
          <div key={item.key} className={styles.panel}>
            <div className={styles.header} onClick={() => toggle(item.key)}>
              <svg
                className={`${styles.arrow} ${isOpen ? styles.arrowOpen : ''}`}
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span className={styles.label}>{item.label}</span>
            </div>
            {isOpen && <div className={styles.content}>{item.children}</div>}
          </div>
        )
      })}
    </div>
  )
}
