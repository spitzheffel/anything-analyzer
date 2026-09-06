import React, { useEffect, useRef, useState } from 'react'
import { Button, Tag, Empty, Spinner, Collapse } from '../ui'
import { IconRobot, IconFileText } from '../ui/Icons'
import { useLocale } from '../i18n'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { AnalysisReport, ChatMessage, CapturedRequest, JsHookRecord } from '@shared/types'
import { stripToolContext } from '@shared/types'
import { resolveContextBudget } from '@shared/model-context-windows'
import { linkifyCitations, parseCitationHref } from '@shared/citations'
import { parseProtocolSpecJson, type ProtocolSpec } from '@shared/protocol-spec'
import { AiLogView } from './AiLogView'
import ContextUsageBar from './ContextUsageBar'
import {
  buildContextUsageSnapshot,
  resolveContextUsedTokens,
  type ConversationTokenUsage,
  type ContextUsageSnapshot,
} from '@shared/token-estimate'
import styles from './ReportView.module.css'

interface ReportViewProps {
  report: AnalysisReport | null
  isAnalyzing: boolean
  analysisError: string | null
  streamingContent: string
  /** 模型思考过程（流式），仅在生成中展示，不落入报告 */
  streamingReasoning?: string
  onReAnalyze: (model?: string) => void
  onCancelAnalysis: () => void
  chatHistory: ChatMessage[]
  isChatting: boolean
  chatError: string | null
  onSendFollowUp: (message: string) => void
  // Context panel data
  sessionName?: string
  requests?: CapturedRequest[]
  hooks?: JsHookRecord[]
  /** 外部传入的上下文占用快照；缺省时组件内估算 */
  contextUsage?: ContextUsageSnapshot | null
  contextSource?: ConversationTokenUsage | null
  availableModels?: string[]
  selectedModel?: string
  isLoadingModels?: boolean
  onModelChange?: (model: string) => void
  onRefreshModels?: () => void
  /** 点击正文里的 [#12] 引用或面板里的端点时，跳到对应请求 */
  onCiteClick?: (seq: number) => void
  /** 结构化 Spec 抽取失败后的重试；返回更新后的报告 */
  onEnsureSpec?: (reportId: string) => Promise<void>
}

function formatTokens(tokens: number | null): string {
  if (tokens === null) return '--'
  return tokens.toLocaleString()
}

// Streaming text display with cursor blinking effect
const StreamingDisplay: React.FC<{ content: string }> = ({ content }) => {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight
  }, [content])

  return (
    <div ref={containerRef} className={styles.streamingContainer}>
      <div className="report-markdown-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {content}
        </ReactMarkdown>
        <span className={styles.cursor} />
      </div>
    </div>
  )
}

const REASONING_PANEL_KEY = 'reasoning'

/** react-markdown 默认只放行 http/https/mailto 等协议；引用链接用的 seq:// 需要额外放行 */
function citationAwareUrlTransform(url: string): string {
  return parseCitationHref(url) !== null ? url : defaultUrlTransform(url)
}

/** 报告正文是模型生成的，只有这几种协议才交给系统打开 */
const EXTERNAL_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

function isSafeExternalLink(href: string | undefined): href is string {
  if (!href) return false
  try {
    return EXTERNAL_LINK_PROTOCOLS.has(new URL(href).protocol)
  } catch {
    return false
  }
}

/**
 * 思考过程折叠块：正文还没开始时默认展开，正文一出现自动收起；用户随时可手动切换。
 */
const ReasoningPanel: React.FC<{ reasoning: string; hasContent: boolean; label: string }> = ({ reasoning, hasContent, label }) => {
  const [open, setOpen] = useState(!hasContent)
  const autoCollapsedRef = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (hasContent && !autoCollapsedRef.current) {
      autoCollapsedRef.current = true
      setOpen(false)
    }
  }, [hasContent])

  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [reasoning, open])

  if (!reasoning) return null

  return (
    <Collapse
      className={styles.reasoningPanel}
      activeKey={open ? [REASONING_PANEL_KEY] : []}
      onChange={(keys) => setOpen(keys.includes(REASONING_PANEL_KEY))}
      items={[{
        key: REASONING_PANEL_KEY,
        label: (
          <span className={styles.reasoningLabel}>
            {label}
            {!hasContent && <span className={styles.cursor} />}
          </span>
        ),
        children: (
          <div ref={bodyRef} className={styles.reasoningBody}>{reasoning}</div>
        ),
      }]}
    />
  )
}

// Quick follow-up suggestions
const QUICK_QUESTION_KEYS = [
  'report.genPython',
  'report.explainCrypto',
  'report.securityRisks',
  'report.listApiParams',
] as const

// Extract unique API endpoints from requests
function extractEndpoints(requests: CapturedRequest[]): { method: string; path: string }[] {
  const seen = new Set<string>()
  const endpoints: { method: string; path: string }[] = []
  for (const r of requests) {
    try {
      const url = new URL(r.url)
      const key = `${r.method} ${url.pathname}`
      if (!seen.has(key)) {
        seen.add(key)
        endpoints.push({ method: r.method, path: url.pathname })
      }
    } catch {
      // skip invalid URLs
    }
  }
  return endpoints.slice(0, 8) // limit to top 8
}

/** 面板里只显示路径部分；解析失败就原样返回 */
function shortenUrlTemplate(urlTemplate: string): string {
  try {
    const url = new URL(urlTemplate)
    return decodeURIComponent(url.pathname) + (url.search ? url.search : '')
  } catch {
    return urlTemplate
  }
}

function getMethodColor(method: string): string {
  switch (method.toUpperCase()) {
    case 'GET': return 'var(--color-success)'
    case 'POST': return 'var(--color-info)'
    case 'PUT': return 'var(--color-orange)'
    case 'DELETE': return 'var(--color-error)'
    default: return 'var(--text-muted)'
  }
}

// Summarize hook types
function summarizeHooks(hooks: JsHookRecord[]): { type: string; count: number; color: string }[] {
  const counts: Record<string, number> = {}
  for (const h of hooks) {
    const type = h.hook_type || 'unknown'
    counts[type] = (counts[type] || 0) + 1
  }
  const colorMap: Record<string, string> = {
    crypto: 'var(--color-warning)',
    fetch: 'var(--color-info)',
    xhr: 'var(--color-info)',
    cookie: 'var(--color-error)',
  }
  return Object.entries(counts).map(([type, count]) => ({
    type,
    count,
    color: colorMap[type] || 'var(--text-muted)',
  }))
}

const ReportView: React.FC<ReportViewProps> = ({
  report,
  isAnalyzing,
  analysisError,
  streamingContent,
  streamingReasoning = '',
  onReAnalyze,
  onCancelAnalysis,
  chatHistory,
  isChatting,
  chatError,
  onSendFollowUp,
  sessionName,
  requests = [],
  hooks = [],
  contextUsage: contextUsageProp = null,
  contextSource = null,
  availableModels = [],
  selectedModel = '',
  isLoadingModels = false,
  onModelChange,
  onRefreshModels,
  onCiteClick,
  onEnsureSpec,
}) => {
  const { t } = useLocale()
  const [chatInput, setChatInput] = useState('')
  const [showAiLog, setShowAiLog] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [isEnsuringSpec, setIsEnsuringSpec] = useState(false)
  const reportBodyRef = useRef<HTMLDivElement>(null)
  const exportMenuRef = useRef<HTMLDivElement>(null)

  const spec: ProtocolSpec | null = React.useMemo(() => parseProtocolSpecJson(report?.spec_json), [report?.spec_json])

  useEffect(() => {
    if (!exportMenuOpen) return
    const close = (event: MouseEvent) => {
      if (!exportMenuRef.current?.contains(event.target as Node)) setExportMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [exportMenuOpen])

  // 正文里的 [#12] 引用渲染成可点击链接；seq:// 之外的链接照常交给系统浏览器
  const markdownComponents = React.useMemo(() => ({
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      const seq = parseCitationHref(href)
      if (seq !== null) {
        // 不给 href：中键 / Ctrl+点击 / 拖拽都不会让 Electron 去打开 seq://，行为完全由 onClick 控制
        return (
          <a
            role="link"
            tabIndex={0}
            className={styles.citation}
            title={`${t('report.jumpToRequest')} #${seq}`}
            onClick={() => onCiteClick?.(seq)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onCiteClick?.(seq)
              }
            }}
          >
            {children}
          </a>
        )
      }
      return (
        <a
          href={href}
          onClick={(event) => {
            event.preventDefault()
            if (isSafeExternalLink(href)) window.electronAPI.openExternal(href)
          }}
        >
          {children}
        </a>
      )
    },
  }), [onCiteClick, t])
  const [budgetCfg, setBudgetCfg] = useState({
    maxContextTokens: 200_000,
    reserveCompletionTokens: 8_192,
    compressionPeak: 0.85,
  })

  useEffect(() => {
    let alive = true
    window.electronAPI.getLLMConfig?.().then((config) => {
      if (!alive || !config) return
      const budget = resolveContextBudget({
        model: selectedModel || report?.llm_model || config.model,
        contextBudget: config.contextBudget,
      })
      setBudgetCfg({
        maxContextTokens: budget.maxContextTokens,
        reserveCompletionTokens: budget.reserveCompletionTokens,
        compressionPeak: budget.compressionPeak,
      })
    }).catch(() => { /* ignore */ })
    return () => { alive = false }
  }, [selectedModel, report?.llm_model])

  const localUsage = React.useMemo(() => {
    const messages = chatHistory.map((m) => ({ content: stripToolContext(m.content) }))
    // 无历史时用报告正文估一个底数
    if (messages.length === 0 && report?.report_content) {
      messages.push({ content: report.report_content })
    }
    const used = resolveContextUsedTokens({
      fallbackMessages: messages,
    })
    return buildContextUsageSnapshot(used, budgetCfg)
  }, [chatHistory, report?.prompt_tokens, report?.report_content, budgetCfg])

  const usage = contextUsageProp ?? localUsage


  // Auto-scroll report body when streaming or new chat messages arrive
  useEffect(() => {
    if ((streamingContent || isChatting) && reportBodyRef.current) {
      reportBodyRef.current.scrollTop = reportBodyRef.current.scrollHeight
    }
  }, [streamingContent, isChatting])

  useEffect(() => {
    if (chatHistory.length > 2 && reportBodyRef.current) {
      requestAnimationFrame(() => {
        if (reportBodyRef.current) {
          reportBodyRef.current.scrollTop = reportBodyRef.current.scrollHeight
        }
      })
    }
  }, [chatHistory.length])

  const handleSend = () => {
    const trimmed = chatInput.trim()
    if (!trimmed || isChatting) return
    onSendFollowUp(trimmed)
    setChatInput('')
  }

  const handleExport = async () => {
    if (!report) return
    const defaultName = `report-${new Date(report.created_at).toISOString().slice(0, 10)}-${report.llm_model}.md`
    let content = report.report_content
    const followUps = chatHistory.slice(2)
    if (followUps.length > 0) {
      content += '\n\n---\n\n## Follow-up Chat\n'
      for (const msg of followUps) {
        const label = msg.role === 'user' ? '**User**' : '**AI**'
        content += `\n${label}:\n\n${stripToolContext(msg.content)}\n`
      }
    }
    await window.electronAPI.exportFile(defaultName, content)
  }

  const handleExportSpec = async () => {
    if (!report) return
    setExportMenuOpen(false)
    await window.electronAPI.exportReportSpec(report.id)
  }

  const handleExportOpenApi = async () => {
    if (!report) return
    setExportMenuOpen(false)
    await window.electronAPI.exportReportOpenApi(report.id)
  }

  const handleEnsureSpec = async () => {
    if (!report || !onEnsureSpec || isEnsuringSpec) return
    setIsEnsuringSpec(true)
    try {
      await onEnsureSpec(report.id)
    } finally {
      setIsEnsuringSpec(false)
    }
  }

  const fallbackEndpoints = extractEndpoints(requests)
  const hookSummary = summarizeHooks(hooks)
  const effectiveModel = selectedModel || report?.llm_model || ''
  const modelOptions = React.useMemo(
    () => [...new Set([...availableModels, effectiveModel].filter(Boolean))],
    [availableModels, effectiveModel],
  )

  // Render right context panel
  const renderContextPanel = () => (
    <div className={styles.reportContext}>
      <div className={styles.contextHeader}>{t('report.title')}</div>

      {/* Session info */}
      <div className={styles.contextSection}>
        <div className={styles.contextLabel}>{t('status.session')}</div>
        {sessionName && (
          <div className={styles.contextItem}>
            <div className={styles.contextDot} style={{ background: 'var(--color-purple)' }} />
            {sessionName}
          </div>
        )}
        <div className={styles.contextItem}>
          <div className={styles.contextDot} style={{ background: 'var(--color-success)' }} />
          {requests.length} {t('data.requests')} · {hooks.length} {t('data.hooks')}
        </div>
      </div>

      {/* Structured spec: scene + summary */}
      {spec && (
        <div className={styles.contextSection}>
          <div className={styles.contextLabel}>{t('report.scene')}</div>
          <div className={styles.contextItem}>
            <div className={styles.contextDot} style={{ background: 'var(--color-accent)' }} />
            {spec.scene}
          </div>
          {spec.summary && <div className={styles.specSummary}>{spec.summary}</div>}
        </div>
      )}

      {/* Spec extraction failed / missing */}
      {report && !spec && (
        <div className={styles.contextSection}>
          <div className={styles.contextLabel}>{t('report.structuredData')}</div>
          <div className={styles.specStatus}>
            {report.spec_error ? t('report.specFailed') : t('report.specMissing')}
            {report.spec_error && <div className={styles.specError} title={report.spec_error}>{report.spec_error}</div>}
          </div>
          {onEnsureSpec && (
            <Button size="sm" loading={isEnsuringSpec} onClick={handleEnsureSpec} style={{ marginTop: 6 }}>
              {t('report.retrySpec')}
            </Button>
          )}
        </div>
      )}

      {/* Endpoints: from the spec when available, otherwise dedupe raw requests */}
      {spec && spec.endpoints.length > 0 ? (
        <div className={styles.contextSection}>
          <div className={styles.contextLabel}>{t('report.endpoints')} · {spec.endpoints.length}</div>
          {spec.endpoints.map((ep, index) => {
            const seq = ep.exampleSeqs[0]
            const clickable = seq !== undefined && !!onCiteClick
            return (
              <div
                key={`${ep.id}-${index}`}
                className={`${styles.contextEndpoint} ${clickable ? styles.contextClickable : ''}`}
                title={`${ep.purpose}${seq !== undefined ? ` · #${seq}` : ''}`}
                onClick={clickable ? () => onCiteClick?.(seq) : undefined}
              >
                <span className={styles.contextMethod} style={{ color: getMethodColor(ep.method) }}>
                  {ep.method}
                </span>
                <span className={styles.contextPath}>{shortenUrlTemplate(ep.urlTemplate)}</span>
                {ep.auth !== 'none' && <span className={styles.authBadge}>{ep.auth}</span>}
                {ep.streaming && <span className={styles.authBadge}>{ep.streaming}</span>}
              </div>
            )
          })}
        </div>
      ) : fallbackEndpoints.length > 0 && (
        <div className={styles.contextSection}>
          <div className={styles.contextLabel}>{t('report.endpoints')}</div>
          {fallbackEndpoints.map((ep, i) => (
            <div key={i} className={styles.contextEndpoint}>
              <span className={styles.contextMethod} style={{ color: getMethodColor(ep.method) }}>
                {ep.method}
              </span>
              <span className={styles.contextPath}>{ep.path}</span>
            </div>
          ))}
        </div>
      )}

      {/* Auth chain from the spec */}
      {spec && spec.authChain.length > 0 && (
        <div className={styles.contextSection}>
          <div className={styles.contextLabel}>{t('report.authChain')}</div>
          {spec.authChain.map((entry, i) => {
            const seq = entry.evidenceSeqs[0]
            const clickable = seq !== undefined && !!onCiteClick
            return (
              <div
                key={i}
                className={`${styles.contextItem} ${clickable ? styles.contextClickable : ''}`}
                title={`${entry.obtainedFrom}${entry.refreshFlow ? ` · ${entry.refreshFlow}` : ''}`}
                onClick={clickable ? () => onCiteClick?.(seq) : undefined}
              >
                <div className={styles.contextDot} style={{ background: 'var(--color-warning)' }} />
                <span>{entry.credentialType}</span>
                <span className={styles.authBadge}>{entry.carriedIn}{entry.keyName ? `:${entry.keyName}` : ''}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* Detected hooks */}
      {hookSummary.length > 0 && (
        <div className={styles.contextSection}>
          <div className={styles.contextLabel}>{t('data.hooks')}</div>
          {hookSummary.map((h, i) => (
            <div key={i} className={styles.contextItem}>
              <div className={styles.contextDot} style={{ background: h.color }} />
              {h.type} × {h.count}
            </div>
          ))}
        </div>
      )}

      {/* Report metadata if available */}
      {report && (
        <div className={styles.contextSection}>
          <div className={styles.contextLabel}>{t('report.reportUsage')}</div>
          <div className={styles.contextItem}>
            <div className={styles.contextDot} style={{ background: 'var(--color-info)' }} />
            {report.llm_model}
          </div>
          {report.prompt_tokens != null && report.completion_tokens != null && (
            <div
              className={styles.contextItem}
              title={t('report.tokenBreakdown', {
                prompt: report.prompt_tokens.toLocaleString(),
                completion: report.completion_tokens.toLocaleString(),
              })}
            >
              <div className={styles.contextDot} style={{ background: 'var(--color-success)' }} />
              {t('report.cumulativeUsage')} {formatTokens(report.prompt_tokens + report.completion_tokens)} tokens
            </div>
          )}
          <div className={styles.contextLabel} style={{ marginTop: 14 }}>{t('report.currentContext')}</div>
          <div className={styles.contextItem}>
            <div className={styles.contextDot} style={{ background: 'var(--color-warning)' }} />
            {contextSource?.model ?? contextSource?.provider ?? t('report.localEstimate')}
            {contextSource && ` · ${t('report.followUpRequest')}`}
          </div>
          <div style={{ marginTop: 8 }}>
            <ContextUsageBar
              usedTokens={usage.usedTokens}
              maxContextTokens={usage.maxContextTokens}
              usableTokens={usage.usableTokens}
              remainingTokens={usage.remainingTokens}
              reserveCompletionTokens={usage.reserveCompletionTokens}
              peakRatio={usage.peakRatio}
              usageRatio={usage.usageRatio}
            />
          </div>
        </div>
      )}
    </div>
  )

  // Analyzing state — full width, no context panel
  if (isAnalyzing) {
    return (
      <div className={styles.reportContainer}>
        <div className={styles.reportMain}>
          <div className={styles.reportBody} ref={reportBodyRef}>
            <div className={styles.reportScroll}>
              <div className={styles.analyzingHeader}>
                <Spinner size="sm" />
                <span>
                  <IconRobot size={14} style={{ marginRight: 4 }} />
                  {t('report.analyzing')}
                </span>
                <div style={{ flex: 1 }} />
                <Button size="sm" onClick={onCancelAnalysis}>
                  {t('report.stopAnalysis')}
                </Button>
              </div>
              <ReasoningPanel
                reasoning={streamingReasoning}
                hasContent={!!streamingContent}
                label={t('report.reasoning')}
              />
              {streamingContent ? (
                <StreamingDisplay content={streamingContent} />
              ) : streamingReasoning ? null : (
                <div className={styles.preparingState}>
                  <Spinner />
                  <div style={{ marginTop: 12 }}>{t('report.preparing')}</div>
                </div>
              )}
            </div>
          </div>
        </div>
        {renderContextPanel()}
      </div>
    )
  }

  // No report yet
  if (!report) {
    return (
      <div className={styles.reportContainer}>
        <div className={styles.reportMain}>
          <div className={styles.emptyState}>
            {analysisError && (
              <div className={styles.errorAlert}>
                <div className={styles.errorTitle}>{t('report.analysisFailed')}</div>
                <div className={styles.errorDesc}>{analysisError}</div>
              </div>
            )}
            <Empty
              icon={<IconFileText size={48} style={{ opacity: 0.25 }} />}
              description={t('report.noReport')}
            />
            <Button variant="primary" icon={<IconRobot size={14} />} onClick={() => onReAnalyze(effectiveModel)}>
              {t('report.startAnalysis')}
            </Button>
          </div>
        </div>
        {renderContextPanel()}
      </div>
    )
  }

  // Has report — show AI Log view if toggled
  if (showAiLog) {
    return (
      <AiLogView
        sessionId={report.session_id}
        sessionName={sessionName}
        onBack={() => setShowAiLog(false)}
      />
    )
  }

  // Has report — full layout with toolbar + content + chat + context panel
  return (
    <div className={styles.reportContainer}>
      <div className={styles.reportMain}>
        {/* Toolbar */}
        <div className={styles.reportToolbar}>
          <div className={styles.toolLabel}>{t('report.analysisModel')}</div>
          <select
            className={styles.modelSelect}
            value={effectiveModel}
            disabled={isChatting}
            onChange={(event) => onModelChange?.(event.target.value)}
            title={t('report.analysisModel')}
          >
            {modelOptions.map(model => (
              <option key={model} value={model}>{model}</option>
            ))}
          </select>
          <button
            className={styles.toolBtn}
            onClick={onRefreshModels}
            disabled={isLoadingModels || isChatting}
            title={t('report.refreshModels')}
          >
            {isLoadingModels ? '…' : '↻'}
          </button>
          <div className={styles.toolSpacer} />
          <div className={styles.exportMenu} ref={exportMenuRef}>
            <button className={styles.toolBtn} onClick={() => setExportMenuOpen((open) => !open)}>
              ⬇ {t('report.exportMenu')} ▾
            </button>
            {exportMenuOpen && (
              <div className={styles.exportDropdown}>
                <button className={styles.exportItem} onClick={() => { setExportMenuOpen(false); void handleExport() }}>
                  {t('report.export')}
                </button>
                <button
                  className={styles.exportItem}
                  disabled={!spec}
                  title={spec ? undefined : t('report.specMissing')}
                  onClick={handleExportSpec}
                >
                  {t('report.exportSpec')}
                </button>
                <button
                  className={styles.exportItem}
                  disabled={!spec}
                  title={spec ? undefined : t('report.specMissing')}
                  onClick={handleExportOpenApi}
                >
                  {t('report.exportOpenApi')}
                </button>
              </div>
            )}
          </div>
          <button className={styles.toolBtn} disabled={isChatting} onClick={() => onReAnalyze(effectiveModel)}>↻ {t('report.reanalyze')}</button>
          <button className={styles.toolBtn} onClick={() => setShowAiLog(true)}>📋 {t('aiLog.title')}</button>
        </div>

        {/* Report content */}
        <div className={styles.reportBody} ref={reportBodyRef}>
          <div className={styles.reportScroll}>
            {/* Metadata row */}
            <div className={styles.metaRow}>
              <span>✦ {report.llm_model}</span>
              <span>◷ {new Date(report.created_at).toLocaleString()}</span>
              <span>{requests.length} {t('data.requests')}</span>
            </div>

            {/* Markdown content ([#12] 引用渲染为可点击链接) */}
            <div className="report-markdown-content" style={{ overflowWrap: 'break-word', wordBreak: 'break-word' }}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={markdownComponents}
                urlTransform={citationAwareUrlTransform}
              >
                {linkifyCitations(report.report_content)}
              </ReactMarkdown>
            </div>


            {/* Chat history */}
            {chatHistory.slice(2).map((msg, i) => (
              <div key={i} className={`${styles.chatMsg} ${msg.role === 'user' ? styles.chatMsgUser : styles.chatMsgAi}`}>
                <Tag color={msg.role === 'user' ? 'info' : 'success'} style={{ marginBottom: 4 }}>
                  {msg.role === 'user' ? 'You' : 'AI'}
                </Tag>
                <div className="report-markdown-content">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={markdownComponents}
                    urlTransform={citationAwareUrlTransform}
                  >
                    {linkifyCitations(stripToolContext(msg.content))}
                  </ReactMarkdown>
                </div>
              </div>
            ))}

            {/* Streaming follow-up */}
            {isChatting && (streamingContent || streamingReasoning) && (
              <div className={`${styles.chatMsg} ${styles.chatMsgAi}`}>
                <Tag color="success" style={{ marginBottom: 4 }}>AI</Tag>
                <ReasoningPanel
                  reasoning={streamingReasoning}
                  hasContent={!!streamingContent}
                  label={t('report.reasoning')}
                />
                {streamingContent && <StreamingDisplay content={streamingContent} />}
              </div>
            )}

            {isChatting && !streamingContent && !streamingReasoning && (
              <div style={{ textAlign: 'center', padding: 12 }}>
                <Spinner size="sm" />
                <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>{t('report.thinking')}</span>
              </div>
            )}

            {chatError && (
              <div className={styles.errorAlert} style={{ marginTop: 12 }}>
                <div className={styles.errorTitle}>{t('report.followUpFailed')}</div>
                <div className={styles.errorDesc}>{chatError}</div>
              </div>
            )}
          </div>
        </div>

        {/* Chat section */}
        <div className={styles.chatSection}>
          <ContextUsageBar
            usedTokens={usage.usedTokens}
            maxContextTokens={usage.maxContextTokens}
            usableTokens={usage.usableTokens}
            remainingTokens={usage.remainingTokens}
            reserveCompletionTokens={usage.reserveCompletionTokens}
            peakRatio={usage.peakRatio}
            usageRatio={usage.usageRatio}
            compact
          />
          <div className={styles.chatSuggestions}>
            {QUICK_QUESTION_KEYS.map((key, i) => {
              const text = t(key)
              return (
                <button
                  key={i}
                  className={styles.chatChip}
                  disabled={isChatting}
                  onClick={() => { if (!isChatting) onSendFollowUp(text) }}
                >
                  {text}
                </button>
              )
            })}
          </div>
          <div className={styles.chatInputBar}>
            <input
              className={styles.chatInput}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={t('report.askFollowUp')}
              disabled={isChatting}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
            />
            <button
              className={styles.chatSend}
              onClick={handleSend}
              disabled={isChatting || !chatInput.trim()}
            >
              ↑
            </button>
          </div>
        </div>
      </div>

      {/* Right context panel */}
      {renderContextPanel()}
    </div>
  )
}

export default ReportView
