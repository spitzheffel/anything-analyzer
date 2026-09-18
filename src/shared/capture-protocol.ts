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
  lastConfirmedAt: number | null
  reason: string | null
}

export interface CaptureGap {
  id?: number
  runId: string
  realmId: string | null
  startedAt: number
  endedAt: number | null
  reason: string
  certainty: 'known-loss' | 'unknown-coverage' | 'delivery-delay'
  droppedEvents: number | null
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
