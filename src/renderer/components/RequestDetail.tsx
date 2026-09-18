import React, { useMemo, useState } from 'react'
import { Tag, Empty } from '../ui'
import type { CapturedRequest, JsHookRecord } from '@shared/types'
import styles from './RequestDetail.module.css'

interface RequestDetailProps {
  request: CapturedRequest | null
  hooks: JsHookRecord[]
}

function safeParse(json: string | null): Record<string, string> | null {
  if (!json) return null
  try { return JSON.parse(json) } catch { return null }
}

function formatContent(content: string | null, contentType?: string | null): string {
  if (!content) return '(empty)'
  const isJson = contentType?.includes('application/json') || content.trimStart().startsWith('{') || content.trimStart().startsWith('[')
  if (isJson) {
    try { return JSON.stringify(JSON.parse(content), null, 2) } catch { return content }
  }
  return content
}

function extractPath(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.pathname + parsed.search
  } catch {
    return url
  }
}

const METHOD_COLORS: Record<string, string> = {
  GET: 'var(--color-success)',
  POST: 'var(--color-info)',
  PUT: 'var(--color-orange)',
  DELETE: 'var(--color-error)',
  PATCH: 'var(--color-info)',
}

const HOOK_TYPE_COLORS: Record<string, 'info' | 'success' | 'purple' | 'orange'> = {
  fetch: 'info',
  xhr: 'success',
  crypto: 'purple',
  crypto_lib: 'purple',
  cookie_set: 'orange',
}

// Sensitive header value highlighting
const HIGHLIGHT_HEADERS: Record<string, string> = {
  authorization: 'var(--color-warning)',
  'x-ss-token': 'var(--color-purple)',
  'x-csrf-token': 'var(--color-warning)',
  cookie: 'var(--color-orange)',
  'set-cookie': 'var(--color-orange)',
}

type DetailTab = 'headers' | 'body' | 'response' | 'hooks'

// KV row component for headers
const KVRow: React.FC<{ k: string; v: string }> = ({ k, v }) => {
  const highlight = HIGHLIGHT_HEADERS[k.toLowerCase()]
  return (
    <div className={styles.kvRow}>
      <div className={styles.kvKey}>{k}</div>
      <div className={styles.kvVal} style={highlight ? { color: highlight } : undefined}>{v}</div>
    </div>
  )
}

// Headers tab — KV pairs layout
const HeadersTab: React.FC<{ request: CapturedRequest }> = ({ request }) => {
  const reqHeaders = safeParse(request.request_headers)
  const resHeaders = safeParse(request.response_headers)
  return (
    <div className={styles.kvSection}>
      <div className={styles.sectionLabel}>REQUEST HEADERS</div>
      {reqHeaders ? (
        Object.entries(reqHeaders).map(([k, v]) => <KVRow key={k} k={k} v={String(v)} />)
      ) : (
        <div className={styles.emptyHint}>(none)</div>
      )}
      <div className={styles.sectionLabel} style={{ marginTop: 14 }}>RESPONSE HEADERS</div>
      {resHeaders ? (
        Object.entries(resHeaders).map(([k, v]) => <KVRow key={k} k={k} v={String(v)} />)
      ) : (
        <div className={styles.emptyHint}>(none)</div>
      )}
    </div>
  )
}

// Body tab
const BodyTab: React.FC<{ request: CapturedRequest }> = ({ request }) => (
  <div className={styles.kvSection}>
    <div className={styles.sectionLabel}>REQUEST BODY</div>
    <pre className={styles.codeBlock}>{formatContent(request.request_body, request.content_type)}</pre>
  </div>
)

// Response tab
const ResponseTab: React.FC<{ request: CapturedRequest }> = ({ request }) => (
  <div className={styles.kvSection}>
    <div className={styles.metaGrid}>
      <div className={styles.metaLabel}>Status</div>
      <div className={styles.metaValue}>{request.status_code ?? '--'}</div>
      <div className={styles.metaLabel}>Content-Type</div>
      <div className={styles.metaValue}>{request.content_type ?? '--'}</div>
      <div className={styles.metaLabel}>Duration</div>
      <div className={styles.metaValue}>{request.duration_ms != null ? `${request.duration_ms} ms` : '--'}</div>
      <div className={styles.metaLabel}>Body capture</div>
      <div className={styles.metaValue} style={{ color: request.body_status === 'unavailable' || request.body_status === 'truncated' ? 'var(--color-warning)' : undefined }}>
        {request.body_status ?? 'unknown (legacy record)'}
        {request.body_error ? `: ${request.body_error}` : ''}
      </div>
    </div>
    <div className={styles.sectionLabel}>RESPONSE BODY</div>
    <pre className={styles.codeBlock}>{formatContent(request.response_body, request.content_type)}</pre>
  </div>
)

// Hooks tab
const HooksTab: React.FC<{ hooks: JsHookRecord[] }> = ({ hooks }) => {
  if (hooks.length === 0) return <Empty description="No related hooks found" />
  return (
    <div className={styles.hookList}>
      {hooks.map((hook) => (
        <div key={hook.id} className={styles.hookItem}>
          <div className={styles.hookHeader}>
            <Tag color={HOOK_TYPE_COLORS[hook.hook_type] || 'default'}>{hook.hook_type}</Tag>
            <code className={styles.hookFn}>{hook.function_name}</code>
            <span className={styles.hookTime}>{new Date(hook.timestamp).toLocaleTimeString()}</span>
          </div>
          <div className={styles.hookArgs}>{hook.arguments}</div>
        </div>
      ))}
    </div>
  )
}

const TAB_LIST: { key: DetailTab; label: string }[] = [
  { key: 'headers', label: 'Headers' },
  { key: 'body', label: 'Body' },
  { key: 'response', label: 'Response' },
  { key: 'hooks', label: 'Hooks' },
]

const RequestDetail: React.FC<RequestDetailProps> = ({ request, hooks }) => {
  const [activeKey, setActiveKey] = useState<DetailTab>('headers')

  const relatedHooks = useMemo(() => {
    if (!request) return []
    return hooks.filter((h) => {
      if (h.related_request_id === request.id) return true
      const timeDiff = request.timestamp - h.timestamp
      return timeDiff >= 0 && timeDiff <= 500
    })
  }, [request, hooks])

  if (!request) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 200 }}>
        <Empty description="Select a request to view details" />
      </div>
    )
  }

  const methodColor = METHOD_COLORS[request.method.toUpperCase()] || 'var(--text-muted)'

  return (
    <div className={styles.container}>
      {/* Header: METHOD STATUS · TIME */}
      <div className={styles.detailHeader}>
        <div className={styles.detailTitle}>
          <span style={{ color: methodColor, fontWeight: 600 }}>{request.method.toUpperCase()}</span>
          {' '}
          {request.status_code ?? '--'} · {request.duration_ms != null ? `${request.duration_ms}ms` : '--'}
        </div>
        <div className={styles.detailUrl}>{request.url}</div>
      </div>

      {/* Simple text tabs */}
      <div className={styles.detailTabs}>
        {TAB_LIST.map(tab => (
          <button
            key={tab.key}
            className={`${styles.detailTab} ${activeKey === tab.key ? styles.detailTabActive : ''}`}
            onClick={() => setActiveKey(tab.key)}
          >
            {tab.label}{tab.key === 'hooks' ? ` (${relatedHooks.length})` : ''}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className={styles.detailBody}>
        {activeKey === 'headers' && <HeadersTab request={request} />}
        {activeKey === 'body' && <BodyTab request={request} />}
        {activeKey === 'response' && <ResponseTab request={request} />}
        {activeKey === 'hooks' && <HooksTab hooks={relatedHooks} />}
      </div>
    </div>
  )
}

export default RequestDetail
