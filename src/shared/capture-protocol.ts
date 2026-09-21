/** Versioned wire contract shared by browser producers and the host receiver. */
export const CAPTURE_PROTOCOL_VERSION = 1 as const
export const CAPTURE_BRIDGE_NAME = '__aaReliableCapture'
export const CAPTURE_PUSH_BINDING = '__aaReliableCapturePush'
export const CAPTURE_WORKER_PATCH_FLAG = '__aaReliableCaptureWorkerPatch'
/**
 * Set by the copy of the bootstrap the router prepends to a worker's entry
 * script, and by nothing else. Its presence in a realm is the only proof that
 * *this* worker instance started from rewritten bytes — a service worker can
 * start again from its script cache without re-fetching, so the URL the router
 * rewrote earlier says nothing about what the current instance is running.
 */
export const CAPTURE_ENTRY_SCRIPT_FLAG = '__aaReliableCaptureEntryScript'

/**
 * 一个事件从页面到落库要过五道尺寸限制：bridge 单事件、bridge 单批次、推送接收、
 * 仓储单事件、仓储单批次。3.6.73 只开了前三道，仓储那两道还是 256 KB / 2 MB，
 * 于是 128 KB 以上 buffer 的批次被整批判 invalid、原样重发、永远进不了库——比原来
 * 在 bridge 里静默丢还糟，因为它连丢失都不算。所以只在这里定义一次：bootstrap 由
 * 构建时注入，controller 和仓储直接引用，不可能再各开各的。
 *
 * 口径：bootstrap 按 UTF-16 记（chars*2+128）；utf8 字节数在任何文本上都不超过它，
 * 所以仓储按同一个数校验一定放得过 bridge 放过的东西。
 */
export const CAPTURE_MAX_EVENT_BYTES = 9 * 1024 * 1024
export const CAPTURE_MAX_BATCH_BYTES = 9 * 1024 * 1024
export const CAPTURE_MAX_QUEUE_BYTES = 32 * 1024 * 1024
/** 推送接收按字符数设限：批次上限的一半（UTF-16 口径）再留余量 */
export const CAPTURE_MAX_PUSH_CHARS = 5 * 1024 * 1024
export interface CaptureProducerLimits {
  maximumEventBytes: number
  maximumBatchBytes: number
  maximumBytes: number
}
export const CAPTURE_PRODUCER_LIMITS: CaptureProducerLimits = {
  maximumEventBytes: CAPTURE_MAX_EVENT_BYTES,
  maximumBatchBytes: CAPTURE_MAX_BATCH_BYTES,
  maximumBytes: CAPTURE_MAX_QUEUE_BYTES,
}

export type CaptureRealmKind = 'document' | 'worker' | 'shared_worker' | 'service_worker'
export type CaptureStream = 'hook' | 'interaction' | 'control'
export type CaptureHealthState = 'starting' | 'healthy' | 'degraded' | 'stopped' | 'unknown'

export interface CaptureEnvelope {
  stream: CaptureStream
  sequence: number
  timestamp: number
  payload: Record<string, unknown>
}

export interface CaptureBatch {
  protocolVersion: typeof CAPTURE_PROTOCOL_VERSION
  runId: string
  producerId: string
  events: CaptureEnvelope[]
  status: CaptureProducerStatus
}

export type CaptureHookInstallationState = 'installed' | 'failed' | 'not-applicable' | 'overwritten'

/**
 * 页面里的 bridge 为什么扔掉了一个事件。以前只有一个总数，"太大""队列满""序列化抛错"
 * 三种情况混在一个数里，健康面板上根本分不出来。
 */
export type CaptureDropReason = 'event-oversize' | 'queue-full' | 'backpressure' | 'serialization-failed'
export const CAPTURE_DROP_REASONS: readonly CaptureDropReason[] =
  ['event-oversize', 'queue-full', 'backpressure', 'serialization-failed']
export type CaptureDropCounts = Record<CaptureDropReason, number>

export interface CaptureProducerStatus {
  /** Live verdict, re-measured on every snapshot and revised by repairs. */
  installed: Record<string, CaptureHookInstallationState>
  /**
   * The first verdict for each hook, written once when it was installed and
   * never revised. A hook that failed at bootstrap and was repaired afterwards
   * reads as `installed` live, but everything the realm ran in between went
   * unhooked — only this field can tell the two apart.
   */
  installedAtBootstrap?: Record<string, CaptureHookInstallationState>
  pendingEvents: number
  pendingBytes: number
  generatedSequence: number
  droppedEvents: number
  /** 按原因拆开的丢弃数；旧版 bootstrap 不上报，字段缺省 */
  droppedByReason?: CaptureDropCounts
  droppedThroughSequence: number
  recording: boolean
}

export interface CaptureBatchReceipt {
  runId: string
  producerId: string
  acknowledged: number[]
  disposition: 'committed' | 'retry' | 'stale' | 'invalid'
}

/** Backend-owned identity; producers cannot choose their session or target. */
export interface CaptureRealmInfo {
  realmId: string
  kind: CaptureRealmKind
  targetId: string
  frameId: string | null
  tabId: string | null
  earlyInjection: boolean
}

export interface CaptureRealmHealth extends CaptureRealmInfo {
  runId: string
  producerId: string | null
  state: CaptureHealthState
  transport: 'push' | 'poll' | 'unavailable'
  installed: CaptureProducerStatus['installed']
  installedAtBootstrap: CaptureProducerStatus['installedAtBootstrap']
  pendingEvents: number
  pendingBytes: number
  droppedEvents: number
  /** 按原因拆开的累计丢弃数；producer 不上报时为空 */
  droppedByReason?: CaptureDropCounts | null
  lastConfirmedAt: number | null
  reason: string | null
}

/**
 * 缺口的细分原因，取自固定集合。
 *
 * 不存 router 给的那句原文：它里面有 URL、targetId 和任意错误文本
 * （例如 `Worker entry script was not rewritten for <id> (<url>)`），
 * 而诊断面板明确承诺不含 URL 与自由文本。分类成有限的码既不泄露内容，
 * 又能回答"到底是哪一类失败"——原来这个问题在界面上完全无解。
 */
export type CaptureFailureCode =
  | 'cdp-websocket-disconnected'
  | 'cdp-transport-invalid'
  | 'cdp-session-mismatch'
  | 'router-connection-failed'
  | 'target-identity-missing'
  | 'target-late-attachment'
  | 'target-pause-guard-expired'
  | 'target-resume-failed'
  | 'target-detach-failed'
  | 'recursive-auto-attach-unavailable'
  | 'document-init-script-failed'
  | 'worker-entry-script-rewrite-failed'
  | 'realm-setup-failed'
  | 'realm-initialization-failed'
  | 'realm-bootstrap-failed'
  | 'realm-callback-failed'
  | 'realm-binding-callback-failed'
  | 'realm-cleanup-failed'
  | 'cdp-cleanup-failed'
  | 'other'

export interface CaptureGap {
  id?: number
  runId: string
  realmId: string | null
  startedAt: number
  endedAt: number | null
  reason: string
  certainty: 'known-loss' | 'unknown-coverage' | 'delivery-delay'
  droppedEvents: number | null
  /** 细分原因；沿用旧快照时为空 */
  detail?: CaptureFailureCode | CaptureDropReason | null
}

/** router 的失败原文 → 有限的码。认不出来时给 'other'，不回落到原文。 */
export function classifyCaptureFailure(reason: string): CaptureFailureCode {
  const rules: Array<[RegExp, CaptureFailureCode]> = [
    [/^CDP WebSocket disconnected/, 'cdp-websocket-disconnected'],
    [/^Invalid CDP transport message/, 'cdp-transport-invalid'],
    [/^CDP response session mismatch/, 'cdp-session-mismatch'],
    [/^Cloak realm router connection failed/, 'router-connection-failed'],
    [/^Attached CDP session/, 'target-identity-missing'],
    [/exceeded the pause guard/, 'target-pause-guard-expired'],
    [/^Late attachment/, 'target-late-attachment'],
    [/^Could not resume target/, 'target-resume-failed'],
    [/^Could not detach stalled target/, 'target-detach-failed'],
    [/^Recursive auto-attach unavailable/, 'recursive-auto-attach-unavailable'],
    [/^Document init-script registration failed/, 'document-init-script-failed'],
    [/^Worker entry[- ]script/, 'worker-entry-script-rewrite-failed'],
    [/^Realm setup failed/, 'realm-setup-failed'],
    [/^Realm initialization failed/, 'realm-initialization-failed'],
    [/^Bootstrap failed in realm/, 'realm-bootstrap-failed'],
    [/^Realm binding callback failed/, 'realm-binding-callback-failed'],
    [/^Realm (close )?callback failed/, 'realm-callback-failed'],
    [/^Realm cleanup failed/, 'realm-cleanup-failed'],
    [/^Root CDP cleanup failed/, 'cdp-cleanup-failed'],
  ]
  for (const [pattern, code] of rules) if (pattern.test(reason)) return code
  return 'other'
}

export interface CaptureHealthSnapshot {
  sessionId: string
  runId: string | null
  revision: number
  state: CaptureHealthState
  network: 'running' | 'stopped' | 'unknown'
  workerCoverage: 'verified' | 'late-attachment' | 'unavailable' | 'unknown'
  realms: CaptureRealmHealth[]
  gaps: CaptureGap[]
  persistenceError: string | null
}

export interface CaptureAcceptedRecord {
  stream: CaptureStream
  record: Record<string, unknown>
}

export interface CaptureIngestionResult {
  receipt: CaptureBatchReceipt
  records: CaptureAcceptedRecord[]
}

export type ResponseBodyStatus = 'saved' | 'empty' | 'skipped' | 'truncated' | 'unavailable' | 'unknown'
