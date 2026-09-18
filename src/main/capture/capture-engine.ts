import { EventEmitter } from 'events'
import type { WebContents } from 'electron'
import type { CapturedRequest, JsHookRecord, StorageSnapshot } from '@shared/types'
import type { RequestsRepo, JsHooksRepo, StorageSnapshotsRepo } from '../db/repositories'
import type { CaptureAcceptedRecord, ResponseBodyStatus } from '@shared/capture-protocol'

/**
 * CaptureEngine — Aggregates data from CDP, JS hooks, and storage collectors,
 * writes structured data to SQLite, and emits IPC events to the renderer.
 */
export class CaptureEngine extends EventEmitter {
  private sessionId: string | null = null
  private rendererWebContents: WebContents | null = null

  constructor(
    private requestsRepo: RequestsRepo,
    private jsHooksRepo: JsHooksRepo,
    private storageSnapshotsRepo: StorageSnapshotsRepo
  ) {
    super()
  }

  start(sessionId: string, rendererWebContents: WebContents): void {
    this.sessionId = sessionId
    this.rendererWebContents = rendererWebContents
  }

  stop(): void {
    this.sessionId = null
    this.rendererWebContents = null
  }

  notifyCommitted(data: CaptureAcceptedRecord): void {
    if (data.record.session_id !== this.sessionId) return
    if (data.stream === 'hook') this.sendToRenderer('capture:hook', data.record)
    if (data.stream === 'interaction') {
      this.sendToRenderer('interaction:recorded', {
        ...data.record, sessionId: data.record.session_id,
      })
    }
  }

  handleResponseCaptured(data: {
    requestId: string; method: string; url: string;
    requestHeaders: string; requestBody: string | null;
    statusCode: number; responseHeaders: string;
    responseBody: string | null; contentType: string | null;
    initiator: string | null; durationMs: number | null;
    isOptions: boolean; isStatic: boolean; isStreaming: boolean; isWebSocket: boolean; truncated: boolean; timestamp: number;
    source?: 'cdp' | 'proxy'
    bodyStatus?: ResponseBodyStatus
    bodyError?: string | null
  }): void {
    if (!this.sessionId) return

    let sequence: number
    // Guard quit race: DB may already be closing during app shutdown.
    try {
      sequence = this.requestsRepo.getNextSequence(this.sessionId)
    } catch (err) {
      console.warn('[CaptureEngine] getNextSequence failed:', (err as Error).message)
      return
    }

    // Generate a unique ID per record to avoid UNIQUE constraint conflicts.
    // The original requestId from CDP/proxy may repeat across sessions or retries.
    const uniqueId = `${this.sessionId}-${sequence}`

    try {
      this.requestsRepo.insert({
        id: uniqueId, session_id: this.sessionId, sequence,
        timestamp: data.timestamp, method: data.method, url: data.url,
        request_headers: data.requestHeaders, request_body: data.requestBody,
        content_type: data.contentType, initiator: data.initiator,
        source: data.source || 'cdp'
      })
    } catch (err) {
      console.warn('[CaptureEngine] Insert failed:', (err as Error).message)
      return
    }

    try {
      this.requestsRepo.updateResponse({
        id: uniqueId, status_code: data.statusCode,
        response_headers: data.responseHeaders,
        response_body: data.responseBody,
        content_type: data.contentType, duration_ms: data.durationMs || 0,
        is_streaming: data.isStreaming ? 1 : 0,
        is_websocket: data.isWebSocket ? 1 : 0,
        body_status: data.bodyStatus ?? 'unknown', body_error: data.bodyError ?? null,
      })
    } catch (error) {
      console.warn('[CaptureEngine] Response persistence failed:', error)
      return
    }

    const captured: CapturedRequest = {
      id: uniqueId, session_id: this.sessionId, sequence,
      timestamp: data.timestamp, method: data.method, url: data.url,
      request_headers: data.requestHeaders, request_body: data.requestBody,
      status_code: data.statusCode, response_headers: data.responseHeaders,
      response_body: data.responseBody, content_type: data.contentType,
      initiator: data.initiator, duration_ms: data.durationMs,
      is_streaming: data.isStreaming, is_websocket: data.isWebSocket,
      source: data.source || 'cdp',
      body_status: data.bodyStatus ?? 'unknown', body_error: data.bodyError ?? null,
    }
    this.sendToRenderer('capture:request', captured)
  }

  handleHookCaptured(data: {
    hookType: string; functionName: string; arguments: string;
    result: string | null; callStack: string | null; timestamp: number
  }): void {
    if (!this.sessionId) return

    const record: Omit<JsHookRecord, 'id'> = {
      session_id: this.sessionId, timestamp: data.timestamp,
      hook_type: data.hookType as JsHookRecord['hook_type'],
      function_name: data.functionName, arguments: data.arguments,
      result: data.result, call_stack: data.callStack, related_request_id: null
    }

    try { this.jsHooksRepo.insert(record) } catch { /* ignore */ }
    this.sendToRenderer('capture:hook', record)
  }

  handleStorageCollected(data: {
    domain: string; storageType: string; data: string; timestamp: number
  }): void {
    if (!this.sessionId) return

    const snapshot: Omit<StorageSnapshot, 'id'> = {
      session_id: this.sessionId, timestamp: data.timestamp,
      domain: data.domain,
      storage_type: data.storageType as StorageSnapshot['storage_type'],
      data: data.data
    }

    try { this.storageSnapshotsRepo.insert(snapshot) } catch { /* ignore */ }
    this.sendToRenderer('capture:storage', snapshot)
  }

  private sendToRenderer(channel: string, data: unknown): void {
    if (this.rendererWebContents && !this.rendererWebContents.isDestroyed()) {
      this.rendererWebContents.send(channel, data)
    }
  }
}
