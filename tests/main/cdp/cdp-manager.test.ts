import { describe, expect, it, vi } from 'vitest'
import { CdpManager } from '../../../src/main/cdp/cdp-manager'
import { StorageCollector } from '../../../src/main/capture/storage-collector'
import type {
  BrowserTarget,
  CdpLease,
  CdpMessage,
  CdpTransport,
  Unsubscribe,
} from '../../../src/main/browser/contracts'

class FakeLease implements CdpLease {
  readonly targetId = 'target-1'
  released = false
  private readonly messageListeners = new Set<(message: CdpMessage) => void>()
  private readonly disconnectListeners = new Set<(reason?: string) => void>()

  constructor(
    readonly owner: string,
    private readonly transport: FakeTransport
  ) {}

  get connected(): boolean {
    return !this.released && this.transport.connected
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    return this.transport.sendForLease<T>(this, method, params)
  }

  onMessage(listener: (message: CdpMessage) => void): Unsubscribe {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onDisconnect(listener: (reason?: string) => void): Unsubscribe {
    this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    this.messageListeners.clear()
    this.disconnectListeners.clear()
    this.transport.release(this)
  }

  emit(message: CdpMessage): void {
    for (const listener of this.messageListeners) listener(message)
  }

  disconnect(reason: string): void {
    for (const listener of this.disconnectListeners) listener(reason)
  }
}

class FakeTransport implements CdpTransport {
  readonly targetId = 'target-1'
  readonly commands: Array<{ owner: string; method: string; params: Record<string, unknown> }> = []
  readonly lifecycle: string[] = []
  closeCalls = 0
  forceCloseCalls = 0
  disconnects = 0
  failMethod: string | null = null
  private readonly leases = new Set<FakeLease>()
  private readonly domainOwners = new Map<string, Set<string>>()
  private underlyingConnected = false
  private bodyGate: Promise<void> | null = null
  private releaseBodyGate: (() => void) | null = null

  get connected(): boolean {
    return this.underlyingConnected && this.leases.size > 0
  }

  async acquire(owner: string): Promise<CdpLease> {
    const lease = new FakeLease(owner, this)
    this.leases.add(lease)
    this.underlyingConnected = true
    this.lifecycle.push(`acquire:${owner}`)
    return lease
  }

  async connect(): Promise<void> {
    this.underlyingConnected = true
  }

  async send<T = Record<string, unknown>>(
    method: string,
    _params: Record<string, unknown> = {}
  ): Promise<T> {
    return this.resultFor(method) as T
  }

  async sendForLease<T>(
    lease: FakeLease,
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    if (lease.released || !this.leases.has(lease)) throw new Error('released lease')
    this.commands.push({ owner: lease.owner, method, params })
    this.lifecycle.push(`send:${lease.owner}:${method}`)
    if (method === this.failMethod) throw new Error(`failed ${method}`)
    const domainOperation = /^(Fetch|Network|Page)\.(enable|disable)$/.exec(method)
    if (domainOperation?.[2] === 'enable') {
      const owners = this.domainOwners.get(domainOperation[1]) ?? new Set<string>()
      owners.add(lease.owner)
      this.domainOwners.set(domainOperation[1], owners)
    }
    if (domainOperation?.[2] === 'disable') {
      const owners = this.domainOwners.get(domainOperation[1]) ?? new Set<string>()
      if ([...owners].some(owner => owner !== lease.owner)) {
        throw new Error('CDP_DOMAIN_CONFLICT')
      }
      owners.delete(lease.owner)
      if (owners.size === 0) this.domainOwners.delete(domainOperation[1])
    }
    if (method.endsWith('.getResponseBody') && this.bodyGate) await this.bodyGate
    return this.resultFor(method) as T
  }

  onMessage(): Unsubscribe { return () => {} }
  onDisconnect(): Unsubscribe { return () => {} }

  async close(): Promise<void> {
    this.closeCalls += 1
  }

  async forceClose(): Promise<void> {
    this.forceCloseCalls += 1
  }

  release(lease: FakeLease): void {
    for (const [domain, owners] of this.domainOwners) {
      owners.delete(lease.owner)
      if (owners.size === 0) this.domainOwners.delete(domain)
    }
    this.leases.delete(lease)
    this.lifecycle.push(`release:${lease.owner}`)
    if (this.leases.size === 0 && this.underlyingConnected) {
      this.underlyingConnected = false
      this.disconnects += 1
    }
  }

  emit(method: string, params: Record<string, unknown>): void {
    for (const lease of this.leases) lease.emit({ method, params })
  }

  disconnectUnexpectedly(reason = 'target closed'): void {
    if (!this.underlyingConnected) return
    this.underlyingConnected = false
    this.disconnects += 1
    for (const lease of [...this.leases]) lease.disconnect(reason)
  }

  deferResponseBodies(): () => void {
    this.bodyGate = new Promise(resolve => {
      this.releaseBodyGate = resolve
    })
    return () => {
      this.releaseBodyGate?.()
      this.releaseBodyGate = null
      this.bodyGate = null
    }
  }

  get leaseCount(): number {
    return this.leases.size
  }

  get claimedDomainCount(): number {
    return this.domainOwners.size
  }

  private resultFor(method: string): unknown {
    if (method === 'Network.getCookies') return { cookies: [] }
    if (method === 'Runtime.evaluate') return { result: { value: '{}' } }
    if (method === 'DOMStorage.getDOMStorageItems') return { entries: [] }
    if (method === 'Network.streamResourceContent') return { bufferedData: '' }
    if (method.endsWith('.getResponseBody')) {
      return { body: '{"ok":true}', base64Encoded: false }
    }
    return {}
  }
}

function createTarget(transport: FakeTransport): BrowserTarget {
  return {
    id: 'target-1',
    tabId: 'tab-1',
    sessionId: 'session-1',
    contextId: 'context-1',
    backendKind: 'cloak',
    url: 'https://example.com/account',
    title: 'Example',
    isClosed: () => false,
    getCdpTransport: async () => transport,
  } as BrowserTarget
}

describe('CdpManager leases and capture modes', () => {
  it('passive mode enables Network without ever enabling Fetch', async () => {
    const transport = new FakeTransport()
    const manager = new CdpManager()
    const responses: Array<Record<string, unknown>> = []
    manager.on('response-captured', response => responses.push(response))

    await manager.start(createTarget(transport), 'passive')

    expect(transport.commands.map(command => command.method)).toEqual(['Network.enable'])
    expect(transport.commands.some(command => command.method === 'Fetch.enable')).toBe(false)

    transport.emit('Network.requestWillBeSent', {
      requestId: 'passive-request',
      request: { method: 'GET', url: 'https://example.com/api', headers: {} },
    })
    transport.emit('Network.responseReceived', {
      requestId: 'passive-request',
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        mimeType: 'application/json',
      },
    })
    transport.emit('Network.loadingFinished', { requestId: 'passive-request' })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({
      statusCode: 200,
      responseBody: '{"ok":true}',
    })

    await manager.stop()
    expect(transport.commands.some(command => command.method.startsWith('Fetch.'))).toBe(false)
    expect(transport.closeCalls).toBe(0)
    expect(transport.forceCloseCalls).toBe(0)
  })

  it('deep mode preserves Fetch response body capture', async () => {
    const transport = new FakeTransport()
    const manager = new CdpManager()
    const responses: Array<Record<string, unknown>> = []
    manager.on('response-captured', response => responses.push(response))
    await manager.start(createTarget(transport), 'deep')

    transport.emit('Fetch.requestPaused', {
      requestId: 'request-1',
      request: {
        method: 'POST',
        url: 'https://example.com/api',
        headers: { 'content-type': 'application/json' },
        postData: '{"input":1}',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    transport.emit('Fetch.requestPaused', {
      requestId: 'request-1',
      responseStatusCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({
      method: 'POST',
      statusCode: 200,
      responseBody: '{"ok":true}',
      truncated: false,
    })
    await manager.stop()
  })

  it('waits for an observed deep response body before disabling domains', async () => {
    const transport = new FakeTransport()
    const manager = new CdpManager()
    const responses: Array<Record<string, unknown>> = []
    manager.on('response-captured', response => responses.push(response))
    await manager.start(createTarget(transport), 'deep')

    transport.emit('Fetch.requestPaused', {
      requestId: 'slow-response',
      request: { method: 'GET', url: 'https://example.com/slow', headers: {} },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    const releaseBody = transport.deferResponseBodies()
    transport.emit('Fetch.requestPaused', {
      requestId: 'slow-response',
      responseStatusCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    const stopping = manager.stop()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(transport.commands.some(command => command.method === 'Fetch.disable')).toBe(false)

    releaseBody()
    await stopping
    expect(responses[0]?.responseBody).toBe('{"ok":true}')
    const methods = transport.commands.map(command => command.method)
    expect(methods.indexOf('Fetch.getResponseBody')).toBeLessThan(methods.indexOf('Fetch.disable'))
  })

  it.each([false, true])('recovers a failed Fetch body through Network, stopping=%s', async (stopDuringRecovery) => {
    const transport = new FakeTransport()
    const manager = new CdpManager()
    const responses: Array<Record<string, unknown>> = []
    manager.on('response-captured', response => responses.push(response))
    await manager.start(createTarget(transport), 'deep')
    transport.emit('Fetch.requestPaused', {
      requestId: 'fetch-script',
      request: { method: 'GET', url: 'https://example.com/app.js', headers: {} },
    })
    transport.failMethod = 'Fetch.getResponseBody'
    transport.emit('Fetch.requestPaused', {
      requestId: 'fetch-script',
      networkId: 'network-script',
      responseStatusCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/javascript' }],
    })
    await vi.waitFor(() => expect(transport.commands.some(command => command.method === 'Fetch.continueResponse')).toBe(true))
    expect(responses).toHaveLength(0)

    const stopping = stopDuringRecovery ? manager.stop() : null
    if (stopping) {
      transport.emit('Fetch.requestPaused', {
        requestId: 'late-request',
        request: { method: 'GET', url: 'https://example.com/late', headers: {} },
      })
      expect(transport.commands).toContainEqual(expect.objectContaining({
        method: 'Fetch.continueRequest', params: { requestId: 'late-request' },
      }))
      expect(transport.commands.some(command => command.method === 'Fetch.disable')).toBe(false)
    }
    transport.emit('Network.loadingFinished', { requestId: 'network-script' })
    await vi.waitFor(() => expect(responses).toHaveLength(1))
    expect(responses[0]).toMatchObject({ responseBody: '{"ok":true}', statusCode: 200 })
    expect(transport.commands).toContainEqual(expect.objectContaining({
      method: 'Network.getResponseBody', params: { requestId: 'network-script' },
    }))
    expect(transport.commands.filter(command => command.method === 'Fetch.continueResponse')).toHaveLength(1)
    await (stopping ?? manager.stop())
    expect(transport.commands.findIndex(command => command.method === 'Network.getResponseBody'))
      .toBeLessThan(transport.commands.findIndex(command => command.method === 'Fetch.disable'))
  })

  it.each(['network-read-failure', 'disconnect', 'missing-completion-event'])(
    'finishes body recovery safely after %s',
    async (failureKind) => {
      vi.useFakeTimers()
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const transport = new FakeTransport()
      const manager = new CdpManager()
      const responses: Array<Record<string, unknown>> = []
      manager.on('response-captured', response => responses.push(response))
      try {
        await manager.start(createTarget(transport), 'deep')
        transport.emit('Fetch.requestPaused', {
          requestId: 'fetch-failure',
          request: { method: 'POST', url: 'https://example.com/api?token=private', headers: {} },
        })
        transport.failMethod = 'Fetch.getResponseBody'
        transport.emit('Fetch.requestPaused', {
          requestId: 'fetch-failure',
          networkId: 'network-failure',
          responseStatusCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        })
        await vi.advanceTimersByTimeAsync(0)
        if (failureKind === 'disconnect') {
          transport.disconnectUnexpectedly()
        } else if (failureKind === 'network-read-failure') {
          transport.failMethod = 'Network.getResponseBody'
          transport.emit('Network.loadingFinished', { requestId: 'network-failure' })
        } else {
          await vi.advanceTimersByTimeAsync(2000)
        }
        await manager.stop()
        expect(responses).toHaveLength(1)
        expect(transport.leaseCount).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
        if (failureKind === 'missing-completion-event') {
          expect(responses[0].responseBody).toBe('{"ok":true}')
          expect(warning).not.toHaveBeenCalled()
        } else {
          expect(responses[0].responseBody).toBeNull()
          expect(warning).toHaveBeenCalledWith('[CdpManager] Response body unavailable', expect.objectContaining({
            sessionId: 'session-1', requestId: 'fetch-failure', error: expect.any(Error), recoveryError: expect.any(Error),
          }))
          expect(JSON.stringify(warning.mock.calls)).not.toContain('private')
        }
      } finally {
        warning.mockRestore()
        vi.useRealTimers()
      }
    },
  )

  it.each([
    ['HEAD', 200], ['GET', 204], ['GET', 304], ['GET', 302],
  ])('does not read an absent body for %s %s', async (method, statusCode) => {
    const transport = new FakeTransport()
    const manager = new CdpManager()
    await manager.start(createTarget(transport), 'deep')
    transport.emit('Fetch.requestPaused', {
      requestId: 'no-body', request: { method, url: 'https://example.com', headers: {} },
    })
    transport.emit('Fetch.requestPaused', {
      requestId: 'no-body', responseStatusCode: statusCode,
      responseHeaders: [{ name: 'content-type', value: 'text/html' }],
    })
    await manager.stop()
    expect(transport.commands.some(command => command.method.endsWith('.getResponseBody'))).toBe(false)
    expect(transport.commands.filter(command => command.method === 'Fetch.continueResponse')).toHaveLength(1)
  })

  it('deep mode never fetches the body of a streaming or upgraded response', async () => {
    const transport = new FakeTransport()
    const manager = new CdpManager()
    const responses: Array<Record<string, unknown>> = []
    manager.on('response-captured', response => responses.push(response))
    await manager.start(createTarget(transport), 'deep')

    transport.emit('Fetch.requestPaused', {
      requestId: 'sse',
      request: { method: 'GET', url: 'https://example.com/stream', headers: {} },
    })
    transport.emit('Fetch.requestPaused', {
      requestId: 'ws',
      request: {
        method: 'GET',
        url: 'wss://example.com/socket',
        headers: { Upgrade: 'websocket' },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    transport.emit('Fetch.requestPaused', {
      requestId: 'sse',
      responseStatusCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream; charset=utf-8' }],
    })
    transport.emit('Fetch.requestPaused', {
      requestId: 'ws',
      responseStatusCode: 101,
      responseHeaders: [],
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(transport.commands.some(command => command.method === 'Fetch.getResponseBody')).toBe(false)
    expect(transport.commands.filter(command => command.method === 'Fetch.continueResponse')).toHaveLength(2)
    expect(responses).toHaveLength(2)
    expect(responses.find(r => r.url === 'https://example.com/stream')).toMatchObject({
      isStreaming: true,
      responseBody: null,
    })
    expect(responses.find(r => r.url === 'wss://example.com/socket')).toMatchObject({
      isWebSocket: true,
      responseBody: null,
    })
    await manager.stop()
  })

  it('accumulates a deep SSE stream body and emits it once the stream ends', async () => {
    const transport = new FakeTransport()
    const manager = new CdpManager()
    const responses: Array<Record<string, unknown>> = []
    manager.on('response-captured', response => responses.push(response))
    await manager.start(createTarget(transport), 'deep')

    transport.emit('Fetch.requestPaused', {
      requestId: 'fetch-1',
      request: { method: 'GET', url: 'https://example.com/stream', headers: {} },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    transport.emit('Fetch.requestPaused', {
      requestId: 'fetch-1',
      networkId: 'net-1',
      responseStatusCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'text/event-stream' }],
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    // Body is not emitted until the stream ends.
    expect(responses).toHaveLength(0)
    expect(transport.commands.some(c => c.method === 'Network.streamResourceContent')).toBe(true)
    expect(transport.commands.some(c => c.method === 'Fetch.getResponseBody')).toBe(false)

    transport.emit('Network.dataReceived', {
      requestId: 'net-1',
      data: Buffer.from('data: one\n\n').toString('base64'),
    })
    transport.emit('Network.dataReceived', {
      requestId: 'net-1',
      data: Buffer.from('data: two\n\n').toString('base64'),
    })
    transport.emit('Network.loadingFinished', { requestId: 'net-1' })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({
      url: 'https://example.com/stream',
      isStreaming: true,
      responseBody: 'data: one\n\ndata: two\n\n',
    })
    await manager.stop()
  })

  it('flushes an open passive stream body when capture stops', async () => {
    const transport = new FakeTransport()
    const manager = new CdpManager()
    const responses: Array<Record<string, unknown>> = []
    manager.on('response-captured', response => responses.push(response))
    await manager.start(createTarget(transport), 'passive')

    transport.emit('Network.requestWillBeSent', {
      requestId: 'net-2',
      request: { method: 'GET', url: 'https://example.com/live', headers: {} },
    })
    transport.emit('Network.responseReceived', {
      requestId: 'net-2',
      response: { status: 200, headers: { 'content-type': 'text/event-stream' } },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    transport.emit('Network.dataReceived', {
      requestId: 'net-2',
      data: Buffer.from('partial chunk').toString('base64'),
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    // Still open — nothing emitted yet.
    expect(responses).toHaveLength(0)

    // Stopping capture flushes whatever the stream has produced so far.
    await manager.stop()
    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({
      url: 'https://example.com/live',
      isStreaming: true,
      responseBody: 'partial chunk',
    })
  })

  it('cleans enabled domains and its lease after partial startup failure', async () => {
    const transport = new FakeTransport()
    transport.failMethod = 'Page.enable'
    const manager = new CdpManager()

    await expect(manager.start(createTarget(transport), 'deep')).rejects.toThrow('failed Page.enable')

    expect(transport.commands.map(command => command.method)).toEqual([
      'Network.enable',
      'Page.enable',
      'Network.disable',
    ])
    expect(transport.claimedDomainCount).toBe(0)
    expect(transport.leaseCount).toBe(0)
  })

  it('releasing one owner leaves other CDP and storage owners connected', async () => {
    const transport = new FakeTransport()
    const target = createTarget(transport)
    const first = new CdpManager()
    const second = new CdpManager()
    const storage = new StorageCollector()

    await first.start(target, 'deep')
    await second.start(target, 'deep')
    await storage.start('session-1', target)

    await first.stop()
    expect(transport.connected).toBe(true)
    expect(transport.disconnects).toBe(0)
    await expect(second.sendCommand('Network.getCookies', {})).resolves.toEqual({ cookies: [] })

    await second.stop()
    expect(transport.connected).toBe(true)
    expect(transport.disconnects).toBe(0)

    storage.triggerCollection()
    await storage.stop()
    expect(transport.connected).toBe(false)
    expect(transport.disconnects).toBe(1)
    expect(transport.closeCalls).toBe(0)
    expect(transport.forceCloseCalls).toBe(0)
    expect(transport.lifecycle.at(-1)).toMatch(/^release:capture:storage:/)
  })

  it('automatically releases network and storage leases after disconnect', async () => {
    const transport = new FakeTransport()
    const target = createTarget(transport)
    const manager = new CdpManager()
    const storage = new StorageCollector()
    await manager.start(target, 'passive')
    await storage.start('session-1', target)

    transport.disconnectUnexpectedly()
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(transport.leaseCount).toBe(0)
    expect(transport.disconnects).toBe(1)
  })

  it('runs one final storage collection and rejects new triggers while stopping', async () => {
    const transport = new FakeTransport()
    const storage = new StorageCollector()
    await storage.start('session-1', createTarget(transport))

    const stopping = storage.stop()
    storage.triggerCollection()
    storage.triggerCollection()
    await stopping

    // Two collections (initial + final on stop), each reading cookies plus
    // local/session storage over the browser-side DOMStorage domain.
    const storageCommands = transport.commands.filter(command =>
      command.method === 'Network.getCookies' ||
      command.method === 'DOMStorage.getDOMStorageItems'
    )
    expect(storageCommands).toHaveLength(6)
    expect(
      transport.commands.some(command => command.method === 'Runtime.evaluate'),
    ).toBe(false)
    expect(transport.lifecycle.at(-1)).toMatch(/^release:capture:storage:/)
  })
})
