import { useEffect, useMemo, useState } from 'react'
import { Input, PasswordInput, TextArea, Select, InputNumber, Button, Switch, Collapse, useToast } from '../../ui'
import type {
  ContextMode,
  CompressionMode,
  LLMGenerationOptions,
  LLMProviderConfig,
  LLMProviderType,
  OpenAIApiType,
  ReasoningEffort,
} from '@shared/types'
import { DEFAULT_CONTEXT_BUDGET, normalizeContextBudget } from '@shared/context-budget-config'
import { lookupModelContextWindow } from '@shared/model-context-windows'

const defaultUrls: Record<LLMProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  minimax: 'https://api.minimax.io/anthropic/v1',
  custom: '',
}

const REASONING_OPTIONS: Array<{ label: string; value: ReasoningEffort }> = [
  { label: '关闭（不发送思考参数）', value: 'none' },
  { label: '低', value: 'low' },
  { label: '中', value: 'medium' },
  { label: '高', value: 'high' },
  { label: '最高', value: 'max' },
]

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 4,
  fontSize: 'var(--font-size-sm)',
  color: 'var(--text-secondary)',
}

const fieldStyle: React.CSSProperties = {
  marginBottom: 16,
}

const sectionTitleStyle: React.CSSProperties = {
  margin: '24px 0 12px',
  fontSize: 'var(--font-size-md)',
  fontWeight: 600,
  color: 'var(--text-primary)',
}

const helpStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 'var(--font-size-xs)',
  color: 'var(--text-tertiary)',
}

const inlineRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
}

function Field({ label, help, children }: { label: string; help?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={fieldStyle}>
      <label style={labelStyle}>{label}</label>
      {children}
      {help && <div style={helpStyle}>{help}</div>}
    </div>
  )
}

function formatTokens(value: number): string {
  return value.toLocaleString()
}

export default function LLMSection() {
  const toast = useToast()

  // ---- 基础接入 ----
  const [name, setName] = useState<LLMProviderType>('openai')
  const [apiType, setApiType] = useState<OpenAIApiType | undefined>('completions')
  const [baseUrl, setBaseUrl] = useState(defaultUrls.openai)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [lightweightModel, setLightweightModel] = useState('')
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)

  // ---- 生成参数 ----
  const [maxTokens, setMaxTokens] = useState<number>(4096)
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('none')
  const [fastMode, setFastMode] = useState(false)
  const [temperature, setTemperature] = useState<number | null>(null)
  const [thinkingBudgetTokens, setThinkingBudgetTokens] = useState<number | null>(null)
  const [extraBodyText, setExtraBodyText] = useState('')

  // ---- 上下文 ----
  const [contextMode, setContextMode] = useState<ContextMode>('index_first')
  const [autoContextWindow, setAutoContextWindow] = useState(true)
  const [maxContextTokens, setMaxContextTokens] = useState(DEFAULT_CONTEXT_BUDGET.maxContextTokens)

  // ---- 高级 ----
  const [compressionPeak, setCompressionPeak] = useState(85)
  const [compressionTarget, setCompressionTarget] = useState(55)
  const [compressionMode, setCompressionMode] = useState<CompressionMode>('rules')
  const [subagentEnabled, setSubagentEnabled] = useState(true)
  const [subagentThreshold, setSubagentThreshold] = useState(400)
  const [subagentChunkSize, setSubagentChunkSize] = useState(120)
  const [maxSubagents, setMaxSubagents] = useState(3)

  const showApiType = name === 'openai' || name === 'custom'
  const isAnthropicLike = name === 'anthropic' || name === 'minimax'
  const fastModeSupported = isAnthropicLike || name === 'openai'

  const detectedWindow = useMemo(() => lookupModelContextWindow(model), [model])
  const effectiveMaxContextTokens = autoContextWindow && detectedWindow
    ? detectedWindow.contextTokens
    : maxContextTokens

  useEffect(() => {
    window.electronAPI.getLLMConfig().then(config => {
      if (!config) return
      setName(config.name)
      setApiType(config.apiType ?? 'completions')
      setBaseUrl(config.baseUrl)
      setApiKey(config.apiKey)
      setModel(config.model)
      setLightweightModel(config.lightweightModel ?? '')
      setMaxTokens(config.maxTokens ?? 4096)

      const generation = config.generation
      if (generation) {
        setReasoningEffort(generation.reasoningEffort ?? 'none')
        setFastMode(generation.fastMode === true)
        setTemperature(typeof generation.temperature === 'number' ? generation.temperature : null)
        setThinkingBudgetTokens(typeof generation.thinkingBudgetTokens === 'number' ? generation.thinkingBudgetTokens : null)
        setExtraBodyText(generation.extraBody ? JSON.stringify(generation.extraBody, null, 2) : '')
      }

      const budget = config.contextBudget
      if (budget) {
        if (budget.maxContextTokens) setMaxContextTokens(budget.maxContextTokens)
        // 旧配置没有该字段时由 normalizeContextBudget 推断：从没改过窗口值的视为自动，手填过的保留
        setAutoContextWindow(normalizeContextBudget(budget).autoContextWindow === true)
        if (budget.compressionPeak) setCompressionPeak(Math.round(budget.compressionPeak * 100))
        if (budget.compressionTarget) setCompressionTarget(Math.round(budget.compressionTarget * 100))
        if (budget.contextMode) setContextMode(budget.contextMode)
        if (budget.compressionMode) setCompressionMode(budget.compressionMode)
        if (budget.subagentEnabled !== undefined) setSubagentEnabled(budget.subagentEnabled)
        if (budget.subagentThreshold) setSubagentThreshold(budget.subagentThreshold)
        if (budget.subagentChunkSize) setSubagentChunkSize(budget.subagentChunkSize)
        if (budget.maxSubagents) setMaxSubagents(budget.maxSubagents)
      }
    })
  }, [])

  const handleProviderChange = (value: string) => {
    const provider = value as LLMProviderType
    const anthropicLike = provider === 'anthropic' || provider === 'minimax'
    setName(provider)
    setBaseUrl(defaultUrls[provider])
    setModelOptions([])
    if (anthropicLike) {
      setApiType(undefined)
    } else if (!apiType) {
      setApiType('completions')
    }
    // 只对部分 Provider 有意义的开关，切换后不要把无效值留在配置里
    if (!anthropicLike && provider !== 'openai') setFastMode(false)
    if (!anthropicLike) setThinkingBudgetTokens(null)
  }

  const parseExtraBody = (): Record<string, unknown> | undefined | null => {
    const trimmed = extraBodyText.trim()
    if (!trimmed) return undefined
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      return parsed as Record<string, unknown>
    } catch {
      return null
    }
  }

  const buildGeneration = (extraBody: Record<string, unknown> | undefined): LLMGenerationOptions | undefined => {
    const generation: LLMGenerationOptions = {}
    if (reasoningEffort !== 'none') generation.reasoningEffort = reasoningEffort
    if (fastMode) generation.fastMode = true
    if (temperature !== null) generation.temperature = temperature
    if (thinkingBudgetTokens !== null && thinkingBudgetTokens > 0) generation.thinkingBudgetTokens = thinkingBudgetTokens
    if (extraBody) generation.extraBody = extraBody
    return Object.keys(generation).length > 0 ? generation : undefined
  }

  const buildConfig = (selectedModel: string, extraBody: Record<string, unknown> | undefined): LLMProviderConfig => ({
    name,
    baseUrl,
    apiKey,
    model: selectedModel,
    maxTokens,
    ...(showApiType && apiType ? { apiType } : {}),
    ...(lightweightModel.trim() ? { lightweightModel: lightweightModel.trim() } : {}),
    generation: buildGeneration(extraBody),
    contextBudget: {
      maxContextTokens: effectiveMaxContextTokens,
      autoContextWindow,
      compressionPeak: compressionPeak / 100,
      compressionTarget: compressionTarget / 100,
      contextMode,
      compressionMode,
      reserveCompletionTokens: maxTokens,
      subagentEnabled,
      subagentThreshold,
      subagentChunkSize,
      maxSubagents,
    },
  })

  const handleLoadModels = async () => {
    if (!baseUrl || !apiKey) {
      toast.warning('请先填写 Base URL 和 API Key')
      return
    }
    setIsLoadingModels(true)
    try {
      const models = await window.electronAPI.listLLMModels(buildConfig(model, undefined))
      setModelOptions(models)
      if (!model && models.length > 0) setModel(models[0])
      toast.success(`已加载 ${models.length} 个模型`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoadingModels(false)
    }
  }

  const handleSave = async () => {
    if (!baseUrl || !apiKey || !model) {
      toast.warning('请填写必填项（Base URL、API Key、Model）')
      return
    }
    const extraBody = parseExtraBody()
    if (extraBody === null) {
      toast.error('额外请求参数必须是合法的 JSON 对象')
      return
    }
    if (compressionTarget >= compressionPeak) {
      toast.warning('压缩目标必须小于压缩峰值')
      return
    }
    const config = buildConfig(model, extraBody)
    await window.electronAPI.saveLLMConfig(config)
    toast.success('LLM 配置已保存')
  }

  const contextWindowHelp = autoContextWindow
    ? detectedWindow
      ? `已识别 ${model}：上下文 ${formatTokens(detectedWindow.contextTokens)} tokens，建议最大输出不超过 ${formatTokens(detectedWindow.maxOutputTokens)} tokens。`
      : model
        ? '未识别该模型的上下文窗口，请手动填写（关闭自动或直接修改数值）。'
        : '填写模型 ID 后自动识别上下文窗口。'
    : '需与模型真实窗口匹配；默认 200000。'

  return (
    <div>
      <div style={sectionTitleStyle}>基础接入</div>

      <Field label="Provider *">
        <Select
          value={name}
          onChange={handleProviderChange}
          options={[
            { label: 'OpenAI', value: 'openai' },
            { label: 'Anthropic', value: 'anthropic' },
            { label: 'MiniMax', value: 'minimax' },
            { label: 'Custom (OpenAI Compatible)', value: 'custom' },
          ]}
        />
      </Field>

      {showApiType && (
        <Field label="API Type">
          <Select
            value={apiType ?? 'completions'}
            onChange={(v) => setApiType(v as OpenAIApiType)}
            options={[
              { label: 'Chat Completions (/chat/completions)', value: 'completions' },
              { label: 'Responses (/responses)', value: 'responses' },
            ]}
          />
        </Field>
      )}

      <Field label="Base URL *">
        <Input
          value={baseUrl}
          onChange={e => setBaseUrl(e.target.value)}
          placeholder="https://api.openai.com/v1"
        />
      </Field>

      <Field label="API Key *">
        <PasswordInput
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder="sk-..."
        />
      </Field>

      <Field label="模型 *" help="可从服务端加载模型列表，也可继续手动输入模型 ID。">
        <div style={{ display: 'flex', gap: 8 }}>
          <Input
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder="gpt-5 / claude-sonnet-4-6 / MiniMax-M2.7 / ..."
            list="llm-model-options"
          />
          <Button size="sm" loading={isLoadingModels} onClick={handleLoadModels}>
            加载模型
          </Button>
        </div>
        <datalist id="llm-model-options">
          {modelOptions.map(option => <option key={option} value={option} />)}
        </datalist>
      </Field>

      <Field
        label="轻量任务模型"
        help="用于预过滤、上下文压缩、并行子分析和报告的结构化抽取（ProtocolSpec）这类不需要深度推理的任务；留空则与主模型相同。建议选同一 Provider 下更便宜的模型。"
      >
        <Input
          value={lightweightModel}
          onChange={e => setLightweightModel(e.target.value)}
          placeholder="留空 = 与主模型相同"
          list="llm-model-options"
        />
      </Field>

      <div style={sectionTitleStyle}>生成参数</div>

      <Field
        label="思考级别"
        help={isAnthropicLike
          ? 'Claude 4.6+ 映射为 adaptive thinking 的 effort；旧模型按级别换算思考预算。'
          : 'OpenAI / 兼容接口映射为 reasoning_effort。关闭时不发送任何思考参数，兼容不支持的模型和中转。'}
      >
        <Select
          value={reasoningEffort}
          onChange={(v) => setReasoningEffort(v as ReasoningEffort)}
          options={REASONING_OPTIONS}
        />
      </Field>

      <Field
        label="快速模式"
        help={fastModeSupported
          ? (isAnthropicLike ? 'Anthropic speed=fast（Opus 4.6+ 支持，输出速度约 2.5 倍，价格更高）。' : 'OpenAI service_tier=fast（需账号有 priority/fast 权限）。')
          : '当前 Provider 不支持快速模式，该开关无效。'}
      >
        <div style={inlineRowStyle}>
          <Switch checked={fastMode} onChange={setFastMode} disabled={!fastModeSupported} />
          <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
            {fastMode ? '已开启' : '关闭'}
          </span>
        </div>
      </Field>

      <Field label="温度" help="留空使用模型默认值。分析任务通常无需调整。">
        <InputNumber
          value={temperature ?? undefined}
          onChange={v => setTemperature(v)}
          min={0}
          max={2}
          step={0.1}
          placeholder="默认"
          style={{ width: '100%' }}
        />
      </Field>

      <Field label="最大输出 tokens" help="单次回复的输出上限，同时作为上下文预算中为回复预留的空间。">
        <InputNumber
          value={maxTokens}
          onChange={v => v !== null && setMaxTokens(v)}
          min={256}
          max={128000}
          style={{ width: '100%' }}
        />
      </Field>

      <div style={sectionTitleStyle}>上下文</div>

      <Field
        label="上下文模式"
        help="默认不把 request/response 正文塞进首轮上下文，由模型调用 get_request_detail 获取。"
      >
        <Select
          value={contextMode}
          onChange={(v) => setContextMode(v as ContextMode)}
          options={[
            { label: '索引优先（推荐，正文按需 tool 拉取）', value: 'index_first' },
            { label: '传统内联（正文直接进 prompt）', value: 'legacy_inline' },
          ]}
        />
      </Field>

      <Field label="最大上下文 (tokens)" help={contextWindowHelp}>
        <div style={inlineRowStyle}>
          <InputNumber
            value={effectiveMaxContextTokens}
            onChange={v => v !== null && setMaxContextTokens(v)}
            min={8192}
            max={2_000_000}
            step={1024}
            disabled={autoContextWindow && !!detectedWindow}
            style={{ flex: 1 }}
          />
          <div style={{ ...inlineRowStyle, gap: 6, whiteSpace: 'nowrap' }}>
            <Switch
              checked={autoContextWindow}
              onChange={(checked) => {
                setAutoContextWindow(checked)
                if (!checked && detectedWindow) setMaxContextTokens(detectedWindow.contextTokens)
              }}
            />
            <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>按模型自动</span>
          </div>
        </div>
      </Field>

      <div style={{ marginTop: 24 }}>
        <Collapse
          items={[{
            key: 'advanced',
            label: '高级设置（压缩策略 / 子分析 / 透传参数）',
            children: (
              <div>
                <Field label="压缩峰值 (%)" help="达到可用上下文的该比例时自动压缩。默认 85%。">
                  <InputNumber
                    value={compressionPeak}
                    onChange={v => v !== null && setCompressionPeak(v)}
                    min={50}
                    max={95}
                    style={{ width: '100%' }}
                  />
                </Field>

                <Field label="压缩目标 (%)" help="压缩后回落到可用上下文的该比例。默认 55%。">
                  <InputNumber
                    value={compressionTarget}
                    onChange={v => v !== null && setCompressionTarget(v)}
                    min={20}
                    max={80}
                    style={{ width: '100%' }}
                  />
                </Field>

                <Field label="压缩方式">
                  <Select
                    value={compressionMode}
                    onChange={(v) => setCompressionMode(v as CompressionMode)}
                    options={[
                      { label: '规则压缩（默认，零额外调用）', value: 'rules' },
                      { label: '混合（规则不足时用轻量模型摘要）', value: 'hybrid' },
                    ]}
                  />
                </Field>

                <Field
                  label="并行子分析"
                  help="请求数超过阈值时，把请求索引拆成多个并行摘要任务（使用轻量任务模型），主分析只接收聚合发现。"
                >
                  <div style={inlineRowStyle}>
                    <Switch checked={subagentEnabled} onChange={setSubagentEnabled} />
                    <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
                      {subagentEnabled ? '启用（仅超阈值触发）' : '禁用'}
                    </span>
                  </div>
                </Field>

                <Field label="触发阈值（请求数）">
                  <InputNumber
                    value={subagentThreshold}
                    onChange={value => value !== null && setSubagentThreshold(value)}
                    min={100}
                    max={10000}
                    step={50}
                    disabled={!subagentEnabled}
                    style={{ width: '100%' }}
                  />
                </Field>

                <Field label="每个子任务请求数">
                  <InputNumber
                    value={subagentChunkSize}
                    onChange={value => value !== null && setSubagentChunkSize(value)}
                    min={40}
                    max={250}
                    step={10}
                    disabled={!subagentEnabled}
                    style={{ width: '100%' }}
                  />
                </Field>

                <Field label="最大并行子任务" help="默认 3。并发越高速度越快，但会增加瞬时 API 请求和费用。">
                  <InputNumber
                    value={maxSubagents}
                    onChange={value => value !== null && setMaxSubagents(value)}
                    min={1}
                    max={8}
                    disabled={!subagentEnabled}
                    style={{ width: '100%' }}
                  />
                </Field>

                {isAnthropicLike && (
                  <Field
                    label="思考预算 tokens（Anthropic budget 模式）"
                    help="仅旧版 Claude 需要；设置后覆盖上面的思考级别，以 thinking.budget_tokens 发送。留空不使用。"
                  >
                    <InputNumber
                      value={thinkingBudgetTokens ?? undefined}
                      onChange={v => setThinkingBudgetTokens(v)}
                      min={1024}
                      max={128000}
                      step={1024}
                      placeholder="留空"
                      style={{ width: '100%' }}
                    />
                  </Field>
                )}

                <Field
                  label="额外请求参数 (JSON)"
                  help='浅合并进每次请求体，用于中转站或模型特有参数，例如 {"top_k": 40} 或 {"enable_thinking": true}。'
                >
                  <TextArea
                    value={extraBodyText}
                    onChange={e => setExtraBodyText(e.target.value)}
                    placeholder='{"top_k": 40}'
                    autoSize={{ minRows: 2, maxRows: 8 }}
                    style={{ fontFamily: 'var(--font-mono)' }}
                  />
                </Field>
              </div>
            ),
          }]}
        />
      </div>

      <div style={{ marginTop: 24 }}>
        <Button variant="primary" block onClick={handleSave}>
          保存 LLM 配置
        </Button>
      </div>
    </div>
  )
}
