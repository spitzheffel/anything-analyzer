import React, { useMemo } from 'react'
import { VirtualTable, Tag } from '../ui'
import type { VTColumn } from '../ui'
import type { CaptureMode, InteractionEvent, InteractionType } from '@shared/types'
import { useLocale } from '../i18n'

interface InteractionLogProps {
  interactions: InteractionEvent[]
  captureMode?: CaptureMode
}

const TYPE_COLORS: Record<InteractionType, 'info' | 'success' | 'purple' | 'orange' | 'warning' | 'error'> = {
  click: 'info',
  dblclick: 'info',
  input: 'success',
  scroll: 'orange',
  navigate: 'purple',
  hover: 'warning',
}

function truncate(str: string | null, maxLen = 60): string {
  if (!str) return '--'
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str
}

const ExpandedRow: React.FC<{ record: InteractionEvent }> = ({ record }) => {
  const { t } = useLocale()

  return (
    <div style={{ padding: '6px 0', fontSize: 'var(--font-size-xs)', lineHeight: 1.6 }}>
      {record.selector && (
        <div style={{ marginBottom: 4 }}>
          <span style={{ color: 'var(--text-muted)', marginRight: 8 }}>{t('interaction.selector')}:</span>
          <code style={{ background: 'var(--color-surface)', padding: '1px 6px', borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}>
            {record.selector}
          </code>
        </div>
      )}
      {record.xpath && (
        <div style={{ marginBottom: 4 }}>
          <span style={{ color: 'var(--text-muted)', marginRight: 8 }}>XPath:</span>
          <code style={{ background: 'var(--color-surface)', padding: '1px 6px', borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}>
            {record.xpath}
          </code>
        </div>
      )}
      {record.attributes && (
        <div style={{ marginBottom: 4 }}>
          <span style={{ color: 'var(--text-muted)', marginRight: 8 }}>Attributes:</span>
          <code style={{ background: 'var(--color-surface)', padding: '2px 6px', borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)', display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {record.attributes}
          </code>
        </div>
      )}
      {record.input_value != null && (
        <div style={{ marginBottom: 4 }}>
          <span style={{ color: 'var(--text-muted)', marginRight: 8 }}>{t('interaction.value')}:</span>
          <code style={{ background: 'var(--color-surface)', padding: '1px 6px', borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}>
            {record.input_value}
          </code>
        </div>
      )}
      {record.path && (
        <div style={{ marginBottom: 4 }}>
          <span style={{ color: 'var(--text-muted)', marginRight: 8 }}>{t('interaction.path')}:</span>
          <span>{t('interaction.points', { count: JSON.parse(record.path).length })}</span>
        </div>
      )}
      {record.url && (
        <div style={{ marginBottom: 4 }}>
          <span style={{ color: 'var(--text-muted)', marginRight: 8 }}>{t('interaction.url')}:</span>
          <span style={{ color: 'var(--text-secondary)' }}>{truncate(record.url, 100)}</span>
        </div>
      )}
    </div>
  )
}

const InteractionLog: React.FC<InteractionLogProps> = ({ interactions, captureMode }) => {
  const { t } = useLocale()

  const typeLabel = (type: InteractionType): string => {
    const key = `interaction.${type}` as const
    return t(key as Parameters<typeof t>[0])
  }

  const columns: VTColumn<InteractionEvent>[] = useMemo(() => [
    {
      key: 'timestamp',
      title: 'Time',
      dataIndex: 'timestamp',
      width: 90,
      render: (val) => new Date(val as number).toLocaleTimeString(),
      sorter: (a, b) => a.timestamp - b.timestamp,
    },
    {
      key: 'type',
      title: 'Type',
      dataIndex: 'type',
      width: 90,
      render: (val) => (
        <Tag color={TYPE_COLORS[val as InteractionType] || 'default'}>
          {typeLabel(val as InteractionType)}
        </Tag>
      ),
      filters: (['click', 'dblclick', 'input', 'scroll', 'navigate', 'hover'] as InteractionType[]).map(tp => ({
        text: typeLabel(tp),
        value: tp,
      })),
      onFilter: (value, record) => record.type === value,
    },
    {
      key: 'element',
      title: t('interaction.element'),
      width: 200,
      render: (_val, record) => {
        if (record.type === 'navigate') return truncate(record.url, 50)
        if (record.type === 'hover') {
          const points = record.path ? JSON.parse(record.path).length : 0
          return <span style={{ color: 'var(--text-muted)' }}>{t('interaction.points', { count: points })}</span>
        }
        if (record.element_text) return truncate(record.element_text, 40)
        if (record.tag_name) return `<${record.tag_name}>`
        return '--'
      },
      ellipsis: true,
    },
    {
      key: 'position',
      title: t('interaction.position'),
      width: 100,
      render: (_val, record) => {
        if (record.viewport_x != null && record.viewport_y != null) {
          return `(${Math.round(record.viewport_x)}, ${Math.round(record.viewport_y)})`
        }
        if (record.x != null && record.y != null) {
          return `(${Math.round(record.x)}, ${Math.round(record.y)})`
        }
        return '--'
      },
    },
    {
      key: 'detail',
      title: t('interaction.value'),
      render: (_val, record) => {
        if (record.type === 'input') return truncate(record.input_value, 30)
        if (record.type === 'scroll') return `↕ ${record.scroll_y ?? 0}`
        if (record.selector) return truncate(record.selector, 40)
        return '--'
      },
      ellipsis: true,
    },
  ], [t]) // eslint-disable-line react-hooks/exhaustive-deps

  if (interactions.length === 0) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--text-muted)',
        fontSize: 'var(--font-size-sm)',
      }}>
        {captureMode === 'passive'
          ? t('capture.deepRequiredInteractions')
          : t('interaction.noData')}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {captureMode === 'passive' && (
        <div style={{ padding: '10px 4px', color: 'var(--color-warning)', fontSize: 'var(--font-size-sm)' }}>
          {t('capture.deepRequiredInteractions')}
        </div>
      )}
      <VirtualTable<InteractionEvent>
        columns={columns}
        data={interactions}
        rowKey="id"
        rowHeight={34}
        expandable={{
          expandedRowRender: (record) => <ExpandedRow record={record} />,
          rowExpandable: (record) => record.type !== 'scroll',
        }}
      />
    </div>
  )
}

export default InteractionLog
