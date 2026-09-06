import { EventEmitter } from 'events'
import type { CaptureMode } from '@shared/types'
import type {
  BrowserTarget,
  CdpLease,
  CdpMessage,
  Unsubscribe,
} from '../browser/contracts'

const MAX_BODY_SIZE = 1024 * 1024 // 1MB
const STATIC_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot|ico|map)(\?|$)/i

const BINARY_CONTENT_TYPES = [
  'image/', 'font/', 'audio/', 'video/',
  'application/octet-stream', 'application/pdf', 'application/zip'
]

// Responses that never reach an "end" (server-sent events, multipart streams).
// Fetch.getResponseBody would block until they finish, which never happens.
const STREAMING_CONTENT_TYPES = ['text/event-stream', 'multipart/x-mixed-replace']

interface RequestInfo {
  method: string
  url: string
  headers: Record<string, string>
  postData: string | null
  timestamp: number
  initiator: unknown
  isOptions: boolean
}

interface ResponseInfo {
  statusCode: number
  headers: Record<string, string>
  contentType: string | null
}

type ManagedDomain = 'Network' | 'Page' | 'Fetch'
const DOMAIN_DISABLE_ORDER: readonly ManagedDomain[] = ['Fetch', 'Page', 'Network']

let nextManagerId = 1

function normalizeHeaders(
  value: unknown,
  lowercaseNames = true
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue
      const { name, value: headerValue } = entry as { name?: unknown; value?: unknown }
      if (typeof name === 'string') {
        headers[lowercaseNames ? name.toLowerCase() : name] = String(headerValue ?? '')
      }
    }
    return headers
  }
  if (!value || typeof value !== 'object') return headers
  for (const [name, headerValue] of Object.entries(value)) {
    headers[lowercaseNames ? name.toLowerCase() : name] = String(headerValue ?? '')
  }
  return headers
}

function isBinaryContent(contentType: string | null): boolean {
  if (!contentType) return false
  const normalized = contentType.toLowerCase()
  return BINARY_CONTENT_TYPES.some(type => normalized.includes(type))
}

function isStreamingContent(contentType: string | null): boolean {
  if (!contentType) return false
  const normalized = contentType.toLowerCase()
  return STREAMING_CONTENT_TYPES.some(type => normalized.includes(type))
}

function isWebSocketUpgrade(headers: Record<string, string>): boolean {
  return Object.entries(headers).some(([key, value]) =>
    key.toLowerCase() === 'upgrade' && value.toLowerCase() === 'websocket'
  )
}

/** Body collection is skipped for payloads that are binary or never terminate. */
function shouldCollectBody(
  requestHeaders: Record<string, string>,
  responseInfo: ResponseInfo,
): boolean {
  if (isBinaryContent(responseInfo.contentType)) return false
  if (isStreamingContent(responseInfo.contentType)) return false
  if (responseInfo.statusCode === 101 || isWebSocketUpgrade(requestHeaders)) return false
  return true
}

function decodeBody(result: Record<string, unknown>): { body: string | null; truncated: boolean } {
  if (typeof result.body !== 'string') return { body: null, truncated: false }
  let body = result.base64Encoded
    ? Buffer.from(result.body, 'base64').toString('utf-8')
    : result.body
  if (body.length <= MAX_BODY_SIZE) return { body, truncated: false }
  body = `${body.substring(0, MAX_BODY_SIZE)}\n[TRUNCATED]`
  return { body, truncated: true }
}

/** Browser-neutral CDP network capture using a ref-counted target lease. */
export class CdpManager extends EventEmitter {
  private readonly ownerId = nextManagerId++
  private target: BrowserTarget | null = null
  private lease: CdpLease | null = null
  private captureMode: CaptureMode = 'deep'
  private pendingRequests = new Map<string, RequestInfo>()
  private pendingResponses = new Map<string, ResponseInfo>()
  // Streaming responses (SSE / multipart) keyed by Network requestId. Their body
  // is accumulated from Network.streamResourceContent and emitted once, when the
  // stream ends or capture stops.
  private readonly pendingStreams = new Map<string, {
    requestInfo: RequestInfo
    responseInfo: ResponseInfo
    chunks: string[]
    byteLength: number
    truncated: boolean
    emitted: boolean
  }>()
  private readonly enabledDomains = new Set<ManagedDomain>()
  private running = false
  private unsubscribeMessage: Unsubscribe | null = null
  private unsubscribeDisconnect: Unsubscribe | null = null
  private readonly inFlightHandlers = new Set<Promise<void>>()
  private stopPromise: Promise<void> | null = null

  async start(target: BrowserTarget, captureMode: CaptureMode = 'deep'): Promise<void> {
    if (this.lease || this.stopPromise) await this.stop()
    if (target.isClosed()) throw new Error('Cannot start CDP on a closed browser target')

    const transport = await target.getCdpTransport()
    const lease = await transport.acquire(
      `capture:network:${target.sessionId}:${target.tabId}:${this.ownerId}`
    )

    this.target = target
    this.lease = lease
    this.captureMode = captureMode

    try {
      this.unsubscribeMessage = lease.onMessage(message => this.queueMessage(message))
      this.unsubscribeDisconnect = lease.onDisconnect(reason => {
        if (this.lease !== lease) return
        this.running = false
        this.pendingRequests.clear()
        this.pendingResponses.clear()
        void this.stop().catch(error => {
          console.warn('[CdpManager] Failed to release disconnected lease:', (error as Error).message)
        })
        this.emit('detached', reason)
      })
      this.running = true
      if (captureMode === 'passive') {
        // Passive capture deliberately avoids Fetch: no interception or page pausing.
        await this.enableDomain(lease, 'Network')
      } else {
        await this.enableDomain(lease, 'Network')
        await this.enableDomain(lease, 'Page')
        // Enable interception last so a partial startup cannot leave requests paused.
        await this.enableDomain(lease, 'Fetch', {
          patterns: [
            { urlPattern: '*', requestStage: 'Request' },
            { urlPattern: '*', requestStage: 'Response' }
          ]
        })
      }
    } catch (error) {
      this.running = false
      this.removeSubscriptions()
      await this.waitForHandlers()
      await this.disableOwnedDomains(lease)
      if (!lease.released) await lease.release().catch(() => undefined)
      if (this.lease === lease) this.resetState()
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    const lease = this.lease
    if (!lease) {
      this.resetState()
      return
    }

    this.stopPromise = this.stopLease(lease)
    try {
      await this.stopPromise
    } finally {
      this.stopPromise = null
    }
  }

  /** Send a raw command through this manager's active lease. */
  async sendCommand(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const lease = this.lease
    if (!lease || lease.released) throw new Error('No active CDP lease')
    return lease.send(method, params)
  }

  private async stopLease(lease: CdpLease): Promise<void> {
    this.running = false
    this.removeSubscriptions()
    try {
      // Finish already-observed Fetch responses before disabling interception,
      // otherwise their request IDs can become invalid before body collection.
      await this.waitForHandlers()
      // Emit whatever open streams have accumulated so far — they never reach a
      // natural end, so stopping capture is their only chance to be recorded.
      this.flushPendingStreams()
      await this.disableOwnedDomains(lease)
      this.pendingRequests.clear()
      this.pendingResponses.clear()
      if (!lease.released) await lease.release()
    } finally {
      if (this.lease === lease) this.resetState()
    }
  }

  private resetState(): void {
    this.running = false
    this.removeSubscriptions()
    this.pendingRequests.clear()
    this.pendingResponses.clear()
    this.pendingStreams.clear()
    this.enabledDomains.clear()
    this.target = null
    this.lease = null
  }

  private removeSubscriptions(): void {
    this.unsubscribeMessage?.()
    this.unsubscribeDisconnect?.()
    this.unsubscribeMessage = null
    this.unsubscribeDisconnect = null
  }

  private async enableDomain(
    lease: CdpLease,
    domain: ManagedDomain,
    params: Record<string, unknown> = {}
  ): Promise<void> {
    await lease.send(`${domain}.enable`, params)
    this.enabledDomains.add(domain)
  }

  private async disableOwnedDomains(lease: CdpLease): Promise<void> {
    if (!lease.connected || lease.released) return
    for (const domain of DOMAIN_DISABLE_ORDER) {
      if (!this.enabledDomains.has(domain)) continue
      try {
        await lease.send(`${domain}.disable`, {})
        this.enabledDomains.delete(domain)
      } catch {
        // A conflicting lease still owns the domain, or the target closed.
      }
    }
  }

  private async waitForHandlers(): Promise<void> {
    while (this.inFlightHandlers.size > 0) {
      await Promise.allSettled([...this.inFlightHandlers])
    }
  }

  private queueMessage(message: CdpMessage): void {
    if (!this.running) return
    const task = this.handleCdpMessage(message.method, message.params).catch(error => {
      console.warn(`[CdpManager] ${message.method} handling failed:`, (error as Error).message)
    })
    this.inFlightHandlers.add(task)
    void task.finally(() => this.inFlightHandlers.delete(task))
  }

  private async handleCdpMessage(
    method: string,
    params: Record<string, unknown>
  ): Promise<void> {
    // Streaming body accumulation is shared by both capture modes: once a
    // response is recognized as a stream we follow its Network requestId here.
    const streamId = typeof params.requestId === 'string' ? params.requestId : null
    if (streamId && this.pendingStreams.has(streamId)) {
      if (method === 'Network.dataReceived') {
        this.appendStream(streamId, params.data as string | undefined)
        return
      }
      if (method === 'Network.loadingFinished') {
        this.finalizeStream(streamId, false)
        return
      }
      if (method === 'Network.loadingFailed') {
        this.finalizeStream(streamId, true)
        return
      }
    }

    if (this.captureMode === 'deep' && method === 'Fetch.requestPaused') {
      await this.handleRequestPaused(params)
      return
    }
    if (this.captureMode === 'passive') {
      switch (method) {
        case 'Network.requestWillBeSent':
          this.handleNetworkRequest(params)
          return
        case 'Network.responseReceived':
          await this.handleNetworkResponse(params)
          return
        case 'Network.loadingFinished':
          await this.handleNetworkLoadingFinished(params)
          return
        case 'Network.loadingFailed':
          this.clearNetworkRequest(params.requestId as string)
          return
      }
    }

    switch (method) {
      case 'Network.webSocketFrameSent':
        this.emit('websocket-frame', { direction: 'sent', ...params })
        break
      case 'Network.webSocketFrameReceived':
        this.emit('websocket-frame', { direction: 'received', ...params })
        break
      case 'Network.webSocketCreated':
        this.emit('websocket-created', params)
        break
      case 'Network.webSocketClosed':
        this.emit('websocket-closed', params)
        break
      case 'Page.frameNavigated':
        this.emit('frame-navigated', params)
        break
    }
  }

  private async handleRequestPaused(params: Record<string, unknown>): Promise<void> {
    const requestId = params.requestId as string
    const responseStatusCode = params.responseStatusCode as number | undefined
    if (responseStatusCode === undefined) {
      await this.handleRequestStage(requestId, params)
    } else {
      await this.handleResponseStage(requestId, params)
    }
  }

  private async handleRequestStage(
    requestId: string,
    params: Record<string, unknown>
  ): Promise<void> {
    const request = params.request as Record<string, unknown>
    const info = this.readRequest(request, params.initiator)
    this.pendingRequests.set(requestId, info)
    this.emitRequest(requestId, info)
    try { await this.send('Fetch.continueRequest', { requestId }) } catch { /* cancelled */ }
  }

  private async handleResponseStage(
    requestId: string,
    params: Record<string, unknown>
  ): Promise<void> {
    const requestInfo = this.pendingRequests.get(requestId)
    const headers = normalizeHeaders(params.responseHeaders)
    const responseInfo: ResponseInfo = {
      statusCode: params.responseStatusCode as number,
      headers,
      contentType: headers['content-type'] || null,
    }

    // A streaming body (SSE / multipart) never terminates, so getResponseBody
    // would block this handler and — since the transport serializes per target
    // — hang every other command. Release the request immediately and follow
    // the body through Network.dataReceived on its networkId instead.
    const networkId = typeof params.networkId === 'string' ? params.networkId : null
    if (requestInfo && networkId && isStreamingContent(responseInfo.contentType)) {
      this.beginStream(networkId, requestInfo, responseInfo)
      // Enable streaming BEFORE releasing the response: once continueResponse
      // lets the body flow, any dataReceived that arrives before streaming is
      // enabled carries no `data`. Enabling first means bufferedData plus every
      // later chunk is captured.
      try {
        const result = await this.send('Network.streamResourceContent', { requestId: networkId })
        this.appendStream(networkId, result.bufferedData as string | undefined)
      } catch { /* stream already ended or unsupported */ }
      try { await this.send('Fetch.continueResponse', { requestId }) } catch { /* cancelled */ }
      this.pendingRequests.delete(requestId)
      return
    }

    let responseBody: string | null = null
    let truncated = false
    if (shouldCollectBody(requestInfo?.headers ?? {}, responseInfo)) {
      try {
        const result = await this.send('Fetch.getResponseBody', { requestId })
        const decoded = decodeBody(result)
        responseBody = decoded.body
        truncated = decoded.truncated
      } catch { /* body unavailable */ }
    }

    if (requestInfo) {
      this.emitResponse(requestId, requestInfo, responseInfo, responseBody, truncated)
    }
    this.clearNetworkRequest(requestId)
    try { await this.send('Fetch.continueResponse', { requestId }) } catch { /* cancelled */ }
  }

  private handleNetworkRequest(params: Record<string, unknown>): void {
    const requestId = params.requestId as string
    if (!requestId) return

    const previous = this.pendingRequests.get(requestId)
    const redirect = params.redirectResponse
    if (previous && redirect && typeof redirect === 'object') {
      this.emitResponse(
        requestId,
        previous,
        this.readNetworkResponse(redirect as Record<string, unknown>),
        null,
        false
      )
    }

    const request = params.request as Record<string, unknown> | undefined
    if (!request) return
    const info = this.readRequest(request, params.initiator)
    this.pendingRequests.set(requestId, info)
    this.pendingResponses.delete(requestId)
    this.emitRequest(requestId, info)
  }

  private async handleNetworkResponse(params: Record<string, unknown>): Promise<void> {
    const requestId = params.requestId as string
    const response = params.response as Record<string, unknown> | undefined
    if (!requestId || !response) return
    const responseInfo = this.readNetworkResponse(response)
    this.pendingResponses.set(requestId, responseInfo)

    // Follow SSE/multipart bodies incrementally: Network.getResponseBody only
    // resolves after loadingFinished, which for a stream can be minutes away.
    const requestInfo = this.pendingRequests.get(requestId)
    if (requestInfo && isStreamingContent(responseInfo.contentType)) {
      this.beginStream(requestId, requestInfo, responseInfo)
      this.pendingRequests.delete(requestId)
      this.pendingResponses.delete(requestId)
      try {
        const result = await this.send('Network.streamResourceContent', { requestId })
        this.appendStream(requestId, result.bufferedData as string | undefined)
      } catch { /* stream already ended or unsupported */ }
    }
  }

  private async handleNetworkLoadingFinished(params: Record<string, unknown>): Promise<void> {
    const requestId = params.requestId as string
    const requestInfo = this.pendingRequests.get(requestId)
    const responseInfo = this.pendingResponses.get(requestId)
    if (!requestInfo || !responseInfo) {
      this.clearNetworkRequest(requestId)
      return
    }

    let responseBody: string | null = null
    let truncated = false
    if (shouldCollectBody(requestInfo.headers, responseInfo)) {
      try {
        const result = await this.send('Network.getResponseBody', { requestId })
        const decoded = decodeBody(result)
        responseBody = decoded.body
        truncated = decoded.truncated
      } catch { /* cached, streamed, or otherwise unavailable */ }
    }

    this.emitResponse(requestId, requestInfo, responseInfo, responseBody, truncated)
    this.clearNetworkRequest(requestId)
  }

  private readRequest(request: Record<string, unknown>, initiator: unknown): RequestInfo {
    const method = typeof request.method === 'string' ? request.method : 'GET'
    return {
      method,
      url: typeof request.url === 'string' ? request.url : '',
      headers: normalizeHeaders(request.headers, false),
      postData: typeof request.postData === 'string' ? request.postData : null,
      timestamp: Date.now(),
      initiator: initiator ?? null,
      isOptions: method.toUpperCase() === 'OPTIONS',
    }
  }

  private readNetworkResponse(response: Record<string, unknown>): ResponseInfo {
    const headers = normalizeHeaders(response.headers)
    return {
      statusCode: typeof response.status === 'number' ? response.status : 0,
      headers,
      contentType: headers['content-type']
        || (typeof response.mimeType === 'string' ? response.mimeType : null),
    }
  }

  private emitRequest(requestId: string, info: RequestInfo): void {
    this.emit('request-captured', {
      requestId,
      method: info.method,
      url: info.url,
      headers: JSON.stringify(info.headers),
      body: info.postData,
      timestamp: info.timestamp,
      initiator: info.initiator ? JSON.stringify(info.initiator) : null,
      isOptions: info.isOptions,
    })
  }

  private emitResponse(
    requestId: string,
    requestInfo: RequestInfo,
    responseInfo: ResponseInfo,
    responseBody: string | null,
    truncated: boolean
  ): void {
    const contentType = responseInfo.contentType
    const isStreaming = contentType?.toLowerCase().includes('text/event-stream') ?? false
    const isWebSocket = responseInfo.statusCode === 101 || isWebSocketUpgrade(requestInfo.headers)

    this.emit('response-captured', {
      requestId,
      method: requestInfo.method,
      url: requestInfo.url,
      requestHeaders: JSON.stringify(requestInfo.headers),
      requestBody: requestInfo.postData,
      statusCode: responseInfo.statusCode,
      responseHeaders: JSON.stringify(responseInfo.headers),
      responseBody,
      contentType,
      initiator: requestInfo.initiator ? JSON.stringify(requestInfo.initiator) : null,
      durationMs: Date.now() - requestInfo.timestamp,
      isOptions: requestInfo.isOptions,
      isStatic: STATIC_EXTENSIONS.test(requestInfo.url),
      isStreaming,
      isWebSocket,
      truncated,
      timestamp: requestInfo.timestamp,
    })
  }

  private beginStream(
    streamId: string,
    requestInfo: RequestInfo,
    responseInfo: ResponseInfo,
  ): void {
    if (this.pendingStreams.has(streamId)) return
    this.pendingStreams.set(streamId, {
      requestInfo,
      responseInfo,
      chunks: [],
      byteLength: 0,
      truncated: false,
      emitted: false,
    })
  }

  private appendStream(streamId: string, data: string | undefined): void {
    const stream = this.pendingStreams.get(streamId)
    if (!stream || typeof data !== 'string' || !data) return
    if (stream.byteLength >= MAX_BODY_SIZE) {
      stream.truncated = true
      return
    }
    // Chunks arrive base64-encoded from Network.dataReceived.
    const decoded = Buffer.from(data, 'base64').toString('utf-8')
    stream.chunks.push(decoded)
    stream.byteLength += decoded.length
  }

  /** Emit the accumulated stream body once the stream ends or capture stops. */
  private finalizeStream(streamId: string, failed: boolean): void {
    const stream = this.pendingStreams.get(streamId)
    this.pendingStreams.delete(streamId)
    if (!stream || stream.emitted) return
    stream.emitted = true

    let body = stream.chunks.join('')
    let truncated = stream.truncated
    if (body.length > MAX_BODY_SIZE) {
      body = `${body.substring(0, MAX_BODY_SIZE)}\n[TRUNCATED]`
      truncated = true
    }
    if (failed && !body) body = '[STREAM FAILED]'
    this.emitResponse(streamId, stream.requestInfo, stream.responseInfo, body || null, truncated)
  }

  /** Flush every still-open stream with whatever body has been collected. */
  private flushPendingStreams(): void {
    for (const streamId of [...this.pendingStreams.keys()]) {
      this.finalizeStream(streamId, false)
    }
  }

  private clearNetworkRequest(requestId: string): void {
    this.pendingRequests.delete(requestId)
    this.pendingResponses.delete(requestId)
  }

  private async send(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.sendCommand(method, params)
  }
}
