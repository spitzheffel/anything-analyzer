import { useEffect, useState } from 'react'
import { Input, PasswordInput, Select, InputNumber, Button, useToast } from '../../ui'
import type { ProxyConfig } from '@shared/types'

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 4,
  fontSize: 'var(--font-size-sm)',
  color: 'var(--text-secondary)',
}

const fieldStyle: React.CSSProperties = {
  marginBottom: 16,
}

export default function ProxySection() {
  const toast = useToast()
  const [proxyType, setProxyType] = useState<ProxyConfig['type']>('none')
  const [host, setHost] = useState('')
  const [port, setPort] = useState(1080)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.electronAPI.getProxyConfig().then(config => {
      if (config) {
        setProxyType(config.type)
        setHost(config.host ?? '')
        setPort(config.port ?? 1080)
        setUsername(config.username ?? '')
        setPassword(config.password ?? '')
      }
    })
  }, [])

  const handleSave = async () => {
    if (proxyType !== 'none' && !host) {
      toast.warning('请输入代理主机')
      return
    }
    const config: ProxyConfig = { type: proxyType, host, port, username, password }
    const impacted = await window.electronAPI.getProxyRestartImpact()
    if (impacted.length > 0) {
      const names = impacted.map(session => session.name).join('、')
      const confirmed = window.confirm(
        `保存代理将重启以下 CloakBrowser Session：${names}。是否继续？`,
      )
      if (!confirmed) return
    }
    setSaving(true)
    try {
      await window.electronAPI.saveProxyConfig(config)
      toast.success('代理设置已保存并生效')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div style={fieldStyle}>
        <label style={labelStyle}>代理类型</label>
        <Select
          value={proxyType}
          onChange={v => setProxyType(v as ProxyConfig['type'])}
          options={[
            { label: '无代理 (直连)', value: 'none' },
            { label: 'HTTP', value: 'http' },
            { label: 'HTTPS', value: 'https' },
            { label: 'SOCKS5', value: 'socks5' },
          ]}
        />
      </div>

      {proxyType && proxyType !== 'none' && (
        <>
          <div style={fieldStyle}>
            <label style={labelStyle}>主机 *</label>
            <Input
              value={host}
              onChange={e => setHost(e.target.value)}
              placeholder="127.0.0.1"
            />
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>端口 *</label>
            <InputNumber
              value={port}
              onChange={v => v !== null && setPort(v)}
              min={1}
              max={65535}
              style={{ width: '100%' }}
              placeholder="1080"
            />
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>用户名（可选）</label>
            <Input
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="留空则无认证"
            />
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>密码（可选）</label>
            <PasswordInput
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="留空则无认证"
            />
          </div>
        </>
      )}

      <Button variant="primary" block loading={saving} onClick={handleSave}>
        保存代理设置
      </Button>
    </div>
  )
}
