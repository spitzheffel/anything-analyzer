import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  CloakRealmRouter,
  type CaptureRealmConnection,
  type CloakRealmRouterOptions
} from '../../../src/main/browser/cloak-realm-router'

const fileMocks = vi.hoisted(() => ({ readFile: vi.fn() }))
vi.mock('node:fs/promises', () => ({ readFile: fileMocks.readFile }))

interface SentCommand {
  id: number
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

interface FakeContext {
  id: number
  uniqueId?: string
  auxData?: { isDefault?: boolean; frameId?: string }
}

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = []
  static holdOpen = false
  static commandHandler: ((socket: FakeWebSocket, command: SentCommand) => boolean) | null = null
  readonly commands: SentCommand[] = []
  readonly contexts = new Map<string, FakeContext[]>()
  /** Response bodies the router asked for, keyed by the intercepted request id. */
  readonly interceptedBodies = new Map<string, string>()
  /** Entry-script URLs the router actually rewrote, and each session's URL. */
  readonly rewrittenUrls = new Set<string>()
  readonly sessionUrls = new Map<string, string>()
  readonly pausedUrls = new Map<string, string>()
  /** Sessions whose instance carries no marker, as if started from a script cache. */
  readonly sessionsStartedFromCache = new Set<string>()
  readyState = 0

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
    if (!FakeWebSocket.holdOpen) queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
    })
  }

  send(contents: string): void {
    if (this.readyState !== 1) throw new Error('Fake socket is closed')
    const command = JSON.parse(contents) as SentCommand
    this.commands.push(command)
    queueMicrotask(() => {
      if (FakeWebSocket.commandHandler?.(this, command)) return
      if (command.method === 'Runtime.enable') {
        for (const context of this.contexts.get(command.sessionId!) ?? []) {
          this.event('Runtime.executionContextCreated', { context }, command.sessionId)
        }
      }
      const result = command.method === 'Page.addScriptToEvaluateOnNewDocument'
        ? { identifier: `init-${command.sessionId}` }
        : command.method === 'Fetch.getResponseBody'
          ? { body: this.interceptedBodies.get(command.params.requestId as string) ?? '', base64Encoded: false }
          : command.method === 'Runtime.evaluate'
            ? String(command.params.expression).includes('__aaReliableCaptureEntryScript')
              ? { result: { type: 'boolean',
                  value: !this.sessionsStartedFromCache.has(command.sessionId!) &&
                    this.rewrittenUrls.has(this.sessionUrls.get(command.sessionId!) ?? '') } }
              : { result: { type: 'undefined' } }
            : {}
      if (command.method === 'Fetch.fulfillRequest') {
        const url = this.pausedUrls.get(command.params.requestId as string)
        if (url) this.rewrittenUrls.add(url)
      }
      this.respond(command, result)
    })
  }

  respond(command: SentCommand, result: Record<string, unknown>, sessionId = command.sessionId): void {
    this.message({ id: command.id, result, ...(sessionId ? { sessionId } : {}) })
  }

  fail(command: SentCommand, message = 'unsupported command'): void {
    this.message({ id: command.id, error: { code: -32601, message }, sessionId: command.sessionId })
  }

  event(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.message({ method, params, ...(sessionId ? { sessionId } : {}) })
  }

  message(message: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
  }

  /**
   * Drive one response-stage interception the way Chromium does, so the router
   * can prepend the bootstrap before the worker that loads this URL attaches.
   */
  async interceptScript(
    url: string, overrides: Record<string, unknown> = {}, body = 'globalThis.entry = true'
  ): Promise<void> {
    const requestId = `intercept-${this.interceptedBodies.size + 1}`
    this.interceptedBodies.set(requestId, body)
    this.pausedUrls.set(requestId, url)
    this.event('Fetch.requestPaused', {
      requestId,
      request: { url },
      resourceType: 'Other',
      responseStatusCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'text/javascript' }],
      ...overrides
    })
    await flushProtocol()
  }

  attach(
    sessionId: string,
    kind: string,
    contexts: FakeContext[] = [{ id: 1, uniqueId: `context-${sessionId}`, auxData: { isDefault: true } }],
    waitingForDebugger = true,
    parentSessionId?: string,
    targetId = `target-${sessionId}`,
    url = `https://fixture.invalid/${sessionId}.js`
  ): void {
    this.contexts.set(sessionId, contexts)
    this.sessionUrls.set(sessionId, url)
    this.event('Target.attachedToTarget', {
      sessionId, waitingForDebugger, targetInfo: { targetId, type: kind, url }
    }, parentSessionId)
  }

  /** The covered path: the entry script is rewritten, then its worker attaches. */
  async attachRewrittenWorker(
    sessionId: string, kind = 'worker', contexts?: FakeContext[], parentSessionId?: string
  ): Promise<void> {
    const url = `https://fixture.invalid/${sessionId}.js`
    await this.interceptScript(url)
    this.attach(sessionId, kind, contexts, true, parentSessionId, `target-${sessionId}`, url)
    await flushProtocol()
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
}

async function flushProtocol(): Promise<void> {
  // Drain bounded protocol chains without advancing the command deadlines.
  for (let iteration = 0; iteration < 60; iteration++) await Promise.resolve()
}

describe('CloakRealmRouter', () => {
  let options: CloakRealmRouterOptions
  let realms: CaptureRealmConnection[]
  let routers: CloakRealmRouter[]

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fileMocks.readFile.mockReset().mockResolvedValue('9234\n/devtools/browser/browser-uuid\n')
    FakeWebSocket.instances = []
    FakeWebSocket.holdOpen = false
    FakeWebSocket.commandHandler = null
    vi.stubGlobal('WebSocket', FakeWebSocket)
    realms = []
    routers = []
    options = {
      bootstrapSource: '(() => { globalThis.captureInstalled = true })()',
      onRealm: vi.fn((realm: CaptureRealmConnection) => realms.push(realm)),
      onClosed: vi.fn(),
      onFailure: vi.fn()
    }
  })

  afterEach(async () => {
    FakeWebSocket.commandHandler = null
    await Promise.all(routers.map((router) => router.dispose()))
    for (const socket of FakeWebSocket.instances) socket.close()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  async function connect(): Promise<{ router: CloakRealmRouter; socket: FakeWebSocket }> {
    const router = await CloakRealmRouter.connect('synthetic-profile', options)
    routers.push(router)
    return { router, socket: FakeWebSocket.instances[0] }
  }

  it('discovers only the exact loopback browser endpoint and configures flattened filtered auto-attach', async () => {
    const { router, socket } = await connect()
    expect(fileMocks.readFile).toHaveBeenCalledWith(join('synthetic-profile', 'DevToolsActivePort'), {
      encoding: 'utf8', signal: expect.any(AbortSignal)
    })
    expect(socket.url).toBe('ws://127.0.0.1:9234/devtools/browser/browser-uuid')
    expect(socket.commands[1]).toMatchObject({
      method: 'Target.setAutoAttach',
      params: {
        autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
        filter: [
          { type: 'page' }, { type: 'iframe' }, { type: 'worker' },
          { type: 'shared_worker' }, { type: 'service_worker' }, { exclude: true }
        ]
      }
    })
    expect(socket.commands[2].method).toBe('Target.setDiscoverTargets')
    expect(router.capabilities).toMatchObject({ flatAutoAttach: true, targetDiscovery: true })
    expect(Object.isFrozen(router.capabilities)).toBe(true)
  })

  it('rejects a stale endpoint before attaching or injecting into a different browser', async () => {
    options.expectedTargetId = 'expected-owned-page'
    await expect(CloakRealmRouter.connect('synthetic-profile', options)).rejects.toThrow('expected Cloak browser')
    const socket = FakeWebSocket.instances[0]
    expect(socket.commands.some(command => command.method === 'Runtime.evaluate')).toBe(false)
    expect(socket.commands.some(command => command.method === 'Target.setAutoAttach' && command.params.autoAttach)).toBe(false)
  })

  it.each([
    '0\n/devtools/browser/browser-uuid',
    '65536\n/devtools/browser/browser-uuid',
    '9234\nws://remote.example/devtools/browser/browser-uuid',
    '9234\n//remote.example/devtools/browser/browser-uuid',
    '9234\n/devtools/page/page-uuid',
    '9234\n/devtools/browser/browser-uuid?redirect=remote',
    '9234\n/devtools/browser/../page/page-uuid',
    '9234\n/devtools/browser/browser-uuid#fragment'
  ])('rejects unsafe or non-browser endpoint content without opening a socket: %s', async (contents) => {
    fileMocks.readFile.mockResolvedValue(contents)
    await expect(CloakRealmRouter.connect('synthetic-profile', options)).rejects.toThrow('Invalid DevToolsActivePort')
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(options.onFailure).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits briefly for the endpoint file but bounds missing or stuck reads', async () => {
    fileMocks.readFile.mockRejectedValue(Object.assign(new Error('not written'), { code: 'ENOENT' }))
    const connecting = CloakRealmRouter.connect('synthetic-profile', options)
    const rejected = expect(connecting).rejects.toThrow('DevToolsActivePort timed out')
    await vi.advanceTimersByTimeAsync(5_000)
    await rejected
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)

    fileMocks.readFile.mockImplementation(() => new Promise(() => {}))
    const stuck = CloakRealmRouter.connect('synthetic-profile', options)
    const stuckRejected = expect(stuck).rejects.toThrow('DevToolsActivePort timed out')
    await vi.advanceTimersByTimeAsync(5_000)
    await stuckRejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds opening the socket and initial root setup', async () => {
    FakeWebSocket.holdOpen = true
    const connecting = CloakRealmRouter.connect('synthetic-profile', options)
    const rejected = expect(connecting).rejects.toThrow('WebSocket connection timed out')
    await flushProtocol()
    await vi.advanceTimersByTimeAsync(3_000)
    await rejected
    expect(FakeWebSocket.instances[0].readyState).toBe(3)
    expect(vi.getTimerCount()).toBe(0)

    FakeWebSocket.holdOpen = false
    FakeWebSocket.commandHandler = (_socket, command) => command.method === 'Target.setAutoAttach' && command.params.autoAttach === true
    const setup = CloakRealmRouter.connect('synthetic-profile', options)
    const setupRejected = expect(setup).rejects.toThrow('Target.setAutoAttach timed out')
    await flushProtocol()
    await vi.advanceTimersByTimeAsync(3_000)
    await setupRejected
    expect(FakeWebSocket.instances[1].readyState).toBe(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('registers document init scripts, filters isolated worlds and injects before resuming', async () => {
    const { router, socket } = await connect()
    socket.attach('page-session', 'page', [
      { id: 10, uniqueId: 'main-world', auxData: { isDefault: true, frameId: 'frame-main' } },
      { id: 11, uniqueId: 'isolated-world', auxData: { isDefault: false, frameId: 'frame-main' } },
      { id: 12, uniqueId: 'unclassified-world' }
    ])
    await flushProtocol()
    expect(realms).toHaveLength(1)
    expect(realms[0].info).toEqual({
      realmId: 'cdp:target-page-session:main-world', kind: 'document', targetId: 'target-page-session',
      frameId: 'frame-main', tabId: null, earlyInjection: true
    })
    const targetCommands = socket.commands.filter((command) => command.sessionId === 'page-session')
    expect(targetCommands.map((command) => command.method)).toEqual([
      'Target.setAutoAttach', 'Page.addScriptToEvaluateOnNewDocument', 'Runtime.enable',
      'Runtime.evaluate', 'Runtime.runIfWaitingForDebugger'
    ])
    expect(targetCommands[1].params).toEqual({ source: options.bootstrapSource })
    expect(targetCommands[3].params).toEqual({
      expression: options.bootstrapSource, contextId: 10, awaitPromise: true, returnByValue: true
    })
    expect(router.capabilities.documentInitScript).toBe('supported')
    expect(options.onFailure).not.toHaveBeenCalled()
  })

  it.each(['worker', 'shared_worker', 'service_worker'])('bootstraps a fresh %s context without requiring document auxData', async (kind) => {
    const { router, socket } = await connect()
    await socket.attachRewrittenWorker('worker-session', kind, [{ id: 5, uniqueId: 'worker-world' }])
    expect(realms[0].info).toMatchObject({ kind, frameId: null, earlyInjection: true })
    const targetCommands = socket.commands.filter((command) => command.sessionId === 'worker-session')
    // Resume precedes Runtime.enable: a freshly registered service worker has
    // no message loop to answer it until then, and the entry-script rewrite
    // already carries the coverage this ordering used to be protecting.
    expect(targetCommands.map((command) => command.method)).toEqual([
      'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger', 'Runtime.enable', 'Runtime.evaluate'
    ])
    const workerBootstrap = String(
      targetCommands.find(command => command.method === 'Runtime.evaluate')?.params.expression
    )
    expect(workerBootstrap).toContain('sourceURL=aa-capture-bootstrap://')
    // Install first, read the marker second, and keep looking for a bounded
    // moment: a module worker's context exists before its first statement
    // runs, so a single read at context creation reports a gap that is not
    // there. Reading first would also delay the hooks behind that wait.
    expect(workerBootstrap.indexOf(options.bootstrapSource))
      .toBeLessThan(workerBootstrap.indexOf('__aaReliableCaptureEntryScript'))
    expect(workerBootstrap).toMatch(/for \(let attempt = 0; attempt < \d+ && !covered/)
    expect(router.capabilities.workerStartupInjection).toBe('supported')
    const commandCount = socket.commands.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(socket.commands).toHaveLength(commandCount) // No router-owned worker polling, even for service workers.
  })

  it('arms entry-script rewriting before auto-attach, since a worker already in flight cannot be covered', async () => {
    const { router, socket } = await connect()
    expect(socket.commands[0]).toMatchObject({
      method: 'Fetch.enable',
      params: { patterns: [{ urlPattern: '*', requestStage: 'Response', resourceType: 'Other' }] }
    })
    expect(socket.commands[1].method).toBe('Target.setAutoAttach')
    expect(router.capabilities.workerScriptRewriting).toBe(true)
  })

  it('prepends the bootstrap to an intercepted entry script and leaves the status intact', async () => {
    const { socket } = await connect()
    await socket.interceptScript('https://fixture.invalid/entry.js', { responseStatusCode: 203 }, 'globalThis.original = 1')
    const fulfil = socket.commands.find((command) => command.method === 'Fetch.fulfillRequest')
    expect(fulfil).toBeDefined()
    expect(fulfil!.params.responseCode).toBe(203)
    const body = Buffer.from(fulfil!.params.body as string, 'base64').toString('utf8')
    // The marker rides ahead of the bootstrap so the realm can prove later
    // that it started from these bytes rather than a cached copy.
    expect(body.startsWith('globalThis["__aaReliableCaptureEntryScript"]=true;')).toBe(true)
    expect(body).toContain(options.bootstrapSource)
    expect(body.endsWith('globalThis.original = 1')).toBe(true)
    expect(socket.commands.some((command) => command.method === 'Fetch.continueRequest')).toBe(false)
  })

  it('serves the rewritten script under the headers the site sent, minus the two the rewrite invalidates', async () => {
    const { socket } = await connect()
    await socket.interceptScript('https://fixture.invalid/sw.js', {
      responseHeaders: [
        { name: 'content-type', value: 'text/javascript' },
        // Widens a service worker's scope; dropping it breaks registration.
        { name: 'Service-Worker-Allowed', value: '/' },
        { name: 'access-control-allow-origin', value: '*' },
        { name: 'content-length', value: '21' },
        { name: 'content-encoding', value: 'gzip' }
      ]
    })
    const fulfil = socket.commands.find((command) => command.method === 'Fetch.fulfillRequest')
    expect(fulfil!.params.responseHeaders).toEqual([
      { name: 'content-type', value: 'text/javascript' },
      { name: 'Service-Worker-Allowed', value: '/' },
      { name: 'access-control-allow-origin', value: '*' }
    ])
  })

  it.each([
    ['a request-stage interception, which has no body to rewrite', { responseStatusCode: undefined }],
    ['a non-script response', { responseHeaders: [{ name: 'content-type', value: 'image/png' }], request: { url: 'https://fixture.invalid/pixel' } }]
  ])('releases %s untouched', async (_case, overrides) => {
    const { socket } = await connect()
    await socket.interceptScript('https://fixture.invalid/entry.js', overrides)
    expect(socket.commands.some((command) => command.method === 'Fetch.fulfillRequest')).toBe(false)
    expect(socket.commands.some((command) => command.method === 'Fetch.continueRequest')).toBe(true)
  })

  it('releases the request and declares the gap when the rewrite itself fails', async () => {
    const { router, socket } = await connect()
    FakeWebSocket.commandHandler = (transport, command) => {
      if (command.method !== 'Fetch.getResponseBody') return false
      transport.fail(command, 'body unavailable')
      return true
    }
    await socket.interceptScript('https://fixture.invalid/worker-session.js')
    expect(options.onFailure).toHaveBeenCalledWith(expect.stringContaining('entry-script rewrite failed'))
    expect(socket.commands.some((command) => command.method === 'Fetch.continueRequest')).toBe(true)
    FakeWebSocket.commandHandler = null
    socket.attach('worker-session', 'worker', [{ id: 1, uniqueId: 'worker-main' }])
    await flushProtocol()
    // The worker still runs; it must report the missing coverage, not claim it.
    expect(realms[0].info.earlyInjection).toBe(false)
    expect(router.capabilities.workerStartupInjection).toBe('degraded')
  })

  it('never claims coverage from waitingForDebugger alone, naming the script that went unrewritten', async () => {
    const { router, socket } = await connect()
    socket.attach('worker-session', 'worker', [{ id: 1, uniqueId: 'worker-main' }], true)
    await flushProtocol()
    expect(realms[0].info.earlyInjection).toBe(false)
    expect(router.capabilities.workerStartupInjection).toBe('degraded')
    expect(options.onFailure).toHaveBeenCalledWith(
      expect.stringContaining('https://fixture.invalid/worker-session.js')
    )
    // Still published and released: an uninstrumented worker is observable.
    expect(socket.commands.some((command) =>
      command.sessionId === 'worker-session' && command.method === 'Runtime.runIfWaitingForDebugger')).toBe(true)
  })

  it('asks the worker instance, not the URL, whether it started from rewritten bytes', async () => {
    const { router, socket } = await connect()
    // A service worker can restart from its script cache without re-fetching,
    // so an earlier rewrite of this URL says nothing about this instance.
    await socket.interceptScript('https://fixture.invalid/cached-worker.js')
    socket.sessionsStartedFromCache.add('cached-worker')
    socket.attach('cached-worker', 'service_worker', [{ id: 1, uniqueId: 'cached-main' }])
    await flushProtocol()
    expect(realms[0].info.earlyInjection).toBe(false)
    expect(router.capabilities.workerStartupInjection).toBe('degraded')
    expect(options.onFailure).toHaveBeenCalledWith(expect.stringContaining('was not rewritten'))
  })

  it('matches rewrites to workers by exact entry URL', async () => {
    const { socket } = await connect()
    await socket.interceptScript('https://fixture.invalid/other-worker.js')
    socket.attach('worker-session', 'worker', [{ id: 1, uniqueId: 'worker-main' }])
    await flushProtocol()
    expect(realms[0].info.earlyInjection).toBe(false)
  })

  it('routes nested iframe and worker sessions, evaluations and binding payloads by both session and context', async () => {
    const { socket } = await connect()
    socket.attach('page-session', 'page')
    await flushProtocol()
    socket.attach('iframe-session', 'iframe', [{ id: 1, uniqueId: 'iframe-main', auxData: { isDefault: true } }], true, 'page-session')
    socket.attach('worker-session', 'worker', [{ id: 1, uniqueId: 'worker-main' }], true, 'iframe-session')
    await flushProtocol()
    expect(realms.map((realm) => realm.info.kind).sort()).toEqual(['document', 'document', 'worker'])
    const iframeRealm = realms.find((realm) => realm.info.targetId === 'target-iframe-session')!
    const workerRealm = realms.find((realm) => realm.info.targetId === 'target-worker-session')!
    const iframePayload = vi.fn()
    const workerPayload = vi.fn()
    await iframeRealm.installBinding('capturePush', iframePayload)
    await workerRealm.installBinding('capturePush', workerPayload)
    socket.event('Runtime.bindingCalled', { name: 'capturePush', executionContextId: 1, payload: 'worker' }, 'worker-session')
    socket.event('Runtime.bindingCalled', { name: 'capturePush', executionContextId: 1, payload: 'frame' }, 'iframe-session')
    socket.event('Runtime.bindingCalled', { name: 'capturePush', executionContextId: 2, payload: 'wrong-context' }, 'worker-session')
    expect(iframePayload).toHaveBeenCalledExactlyOnceWith('frame')
    expect(workerPayload).toHaveBeenCalledExactlyOnceWith('worker')

    FakeWebSocket.commandHandler = (transport, command) => {
      if (command.method !== 'Runtime.evaluate') return false
      transport.respond(command, { result: { type: 'string', value: command.sessionId } })
      return true
    }
    await expect(iframeRealm.evaluate<string>('globalThis.location.href')).resolves.toBe('iframe-session')
    await expect(workerRealm.evaluate<string>('globalThis.location.href')).resolves.toBe('worker-session')
    socket.event('Target.detachedFromTarget', { sessionId: 'page-session' })
    expect(options.onClosed).toHaveBeenCalledTimes(3)
    await expect(workerRealm.evaluate('1')).rejects.toThrow('is closed')
  })

  it('labels already-running documents and workers late, including contexts created after a worker was resumed', async () => {
    const { router, socket } = await connect()
    socket.attach('late-page', 'page', undefined, false)
    socket.attach('late-worker', 'worker', undefined, false)
    await flushProtocol()
    expect(realms).toHaveLength(2)
    expect(realms.every((realm) => !realm.info.earlyInjection)).toBe(true)
    // A worker's gap is named by its unrewritten entry script, not by attach timing.
    expect(options.onFailure).toHaveBeenCalledWith(
      expect.stringContaining('https://fixture.invalid/late-worker.js')
    )
    expect(options.onFailure).toHaveBeenCalledWith(expect.stringContaining('Late attachment to document'))
    expect(router.capabilities.workerStartupInjection).toBe('degraded')
    socket.event('Runtime.executionContextCreated', { context: { id: 2, uniqueId: 'later-worker' } }, 'late-worker')
    await flushProtocol()
    expect(realms.find((realm) => realm.info.realmId.endsWith('later-worker'))?.info.earlyInjection).toBe(false)
  })

  it('recognizes future document contexts protected by the registered init script after a late initial attachment', async () => {
    const { socket } = await connect()
    socket.attach('page-session', 'page', undefined, false)
    await flushProtocol()
    expect(realms[0].info.earlyInjection).toBe(false)
    socket.event('Runtime.executionContextsCleared', {}, 'page-session')
    socket.event('Runtime.executionContextCreated', {
      context: { id: 2, uniqueId: 'next-navigation', auxData: { isDefault: true, frameId: 'frame-main' } }
    }, 'page-session')
    await flushProtocol()
    expect(realms[1].info.earlyInjection).toBe(true)
    expect(options.onClosed).toHaveBeenCalledExactlyOnceWith(realms[0].info.realmId)
  })

  it('keeps a service worker realm open while another session still observes it', async () => {
    const { socket } = await connect()
    // Chromium attaches the same service worker once per parent that auto-attaches.
    socket.attach('sw-via-page', 'service_worker', [{ id: 7, uniqueId: 'sw-world' }],
      false, 'page-session', 'sw-target')
    await flushProtocol()
    socket.attach('sw-via-browser', 'service_worker', [{ id: 7, uniqueId: 'sw-world' }],
      false, undefined, 'sw-target')
    await flushProtocol()
    const realmId = realms[0].info.realmId
    expect(realms.every(realm => realm.info.realmId === realmId)).toBe(true)

    // The page goes away; the worker it spoke to is still running.
    socket.event('Target.detachedFromTarget', { sessionId: 'sw-via-page' })
    await flushProtocol()
    expect(options.onClosed).not.toHaveBeenCalled()

    // Only when the last view of it is gone is the realm actually closed.
    socket.event('Target.detachedFromTarget', { sessionId: 'sw-via-browser' })
    await flushProtocol()
    expect(options.onClosed).toHaveBeenCalledExactlyOnceWith(realmId)
  })

  it('releases an idle service worker with no execution context and never polls for its revival', async () => {
    const { router, socket } = await connect()
    socket.attach('idle-worker', 'service_worker', [])
    await flushProtocol()
    expect(realms).toHaveLength(0)
    expect(socket.commands.at(-1)?.method).toBe('Runtime.enable')
    // No realm was published, so there is no coverage claim to contradict and
    // nothing to report — an idle worker that never ran captured nothing.
    expect(options.onFailure).not.toHaveBeenCalled()
    expect(router.capabilities.workerStartupInjection).toBe('unknown')
    const commandCount = socket.commands.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(socket.commands).toHaveLength(commandCount)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not claim early document injection when init-script registration fails and always resumes setup failures', async () => {
    const { router, socket } = await connect()
    FakeWebSocket.commandHandler = (transport, command) => {
      if (command.method === 'Page.addScriptToEvaluateOnNewDocument' ||
          (command.method === 'Runtime.enable' && command.sessionId === 'broken-worker')) {
        transport.fail(command)
        return true
      }
      return false
    }
    socket.attach('page-session', 'page')
    socket.attach('broken-worker', 'worker')
    socket.attach('unsupported-target', 'other')
    await flushProtocol()
    expect(realms).toHaveLength(1)
    expect(realms[0].info.earlyInjection).toBe(false)
    expect(router.capabilities.documentInitScript).toBe('degraded')
    for (const sessionId of ['page-session', 'broken-worker', 'unsupported-target']) {
      expect(socket.commands).toContainEqual(expect.objectContaining({ method: 'Runtime.runIfWaitingForDebugger', sessionId }))
    }
    expect(options.onFailure).toHaveBeenCalledWith(expect.stringContaining('Document init-script registration failed'))
    expect(options.onFailure).toHaveBeenCalledWith(expect.stringContaining('Realm setup failed'))
  })

  it('reports recursive attachment failures but still injects the attached worker and releases it', async () => {
    const { router, socket } = await connect()
    await socket.interceptScript('https://fixture.invalid/worker-session.js')
    FakeWebSocket.commandHandler = (transport, command) => {
      if (command.method !== 'Target.setAutoAttach' || !command.sessionId) return false
      transport.fail(command)
      return true
    }
    socket.attach('worker-session', 'worker')
    await flushProtocol()
    // Recursive attachment is unrelated to entry coverage: the script was rewritten.
    expect(realms[0].info.earlyInjection).toBe(true)
    expect(router.capabilities.recursiveAutoAttach).toBe('degraded')
    expect(options.onFailure).toHaveBeenCalledWith(expect.stringContaining('Recursive auto-attach unavailable'))
    expect(socket.commands.at(-1)?.method).toBe('Runtime.evaluate')
  })

  it('times out bootstrap and evaluation, ignores late responses, and permits subsequent commands', async () => {
    const { socket } = await connect()
    const heldCommands: SentCommand[] = []
    FakeWebSocket.commandHandler = (_transport, command) => {
      if (command.method !== 'Runtime.evaluate') return false
      heldCommands.push(command)
      return true
    }
    socket.attach('worker-session', 'worker')
    await flushProtocol()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(realms).toHaveLength(1)
    expect(realms[0].info.earlyInjection).toBe(false)
    expect(options.onFailure).toHaveBeenCalledWith(expect.stringContaining('Bootstrap failed'))
    expect(socket.commands).toContainEqual(expect.objectContaining({ method: 'Runtime.runIfWaitingForDebugger' }))
    socket.respond(heldCommands[0], { result: { type: 'string', value: 'late-bootstrap' } })
    expect(realms).toHaveLength(1)

    const evaluating = realms[0].evaluate('neverResolves()')
    const rejected = expect(evaluating).rejects.toThrow('Runtime.evaluate timed out')
    await vi.advanceTimersByTimeAsync(3_000)
    await rejected
    socket.respond(heldCommands[1], { result: { type: 'string', value: 'late-result' } })
    FakeWebSocket.commandHandler = null
    await expect(realms[0].evaluate('undefined')).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('enforces a total pause guard even when several setup commands each finish within their deadlines', async () => {
    const { socket } = await connect()
    FakeWebSocket.commandHandler = (transport, command) => {
      if (command.method === 'Target.setAutoAttach' && command.sessionId) {
        setTimeout(() => transport.respond(command, {}), 2_500)
        return true
      }
      if (command.method === 'Page.addScriptToEvaluateOnNewDocument') {
        setTimeout(() => transport.respond(command, { identifier: 'slow-init' }), 2_700)
        return true
      }
      return false
    }
    socket.attach('slow-page', 'page')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(socket.commands).toContainEqual(expect.objectContaining({
      method: 'Runtime.runIfWaitingForDebugger', sessionId: 'slow-page'
    }))
    expect(options.onFailure).toHaveBeenCalledWith(expect.stringContaining('pause guard'))
    await vi.advanceTimersByTimeAsync(200)
    expect(realms[0].info.earlyInjection).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('detaches a target if the unconditional resume command fails', async () => {
    const { socket } = await connect()
    FakeWebSocket.commandHandler = (transport, command) => {
      if (command.method !== 'Runtime.runIfWaitingForDebugger') return false
      transport.fail(command, 'resume unavailable')
      return true
    }
    // A document publishes its realm before the release, so the detach is
    // observable against a live realm.
    socket.attach('page-session', 'page', undefined, false)
    await flushProtocol()
    expect(socket.commands).toContainEqual(expect.objectContaining({
      method: 'Target.detachFromTarget', params: { sessionId: 'page-session' }
    }))
    expect(options.onClosed).toHaveBeenCalledExactlyOnceWith(realms[0].info.realmId)
    expect(options.onFailure).toHaveBeenCalledWith(expect.stringContaining('Could not resume target'))
  })

  it('closes the owned debugger socket if resume and last-resort detach both fail', async () => {
    const { router, socket } = await connect()
    FakeWebSocket.commandHandler = (transport, command) => {
      if (command.method !== 'Runtime.runIfWaitingForDebugger' && command.method !== 'Target.detachFromTarget') return false
      transport.fail(command)
      return true
    }
    socket.attach('page-session', 'page', undefined, false)
    await flushProtocol()
    expect(socket.readyState).toBe(3)
    expect(options.onClosed).toHaveBeenCalledExactlyOnceWith(realms[0].info.realmId)
    expect(options.onFailure).toHaveBeenCalledWith(expect.stringContaining('Could not detach stalled target'))
    expect(router.capabilities.flatAutoAttach).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds resume and detach deadlines instead of retaining a silently paused target', async () => {
    const { socket } = await connect()
    FakeWebSocket.commandHandler = (_transport, command) =>
      command.method === 'Runtime.runIfWaitingForDebugger' || command.method === 'Target.detachFromTarget'
    socket.attach('worker-session', 'worker')
    await flushProtocol()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(socket.commands.at(-1)?.method).toBe('Target.detachFromTarget')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(socket.readyState).toBe(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects mismatched-session replies, handles evaluation exceptions and restores failed bindings', async () => {
    const { socket } = await connect()
    socket.attach('worker-session', 'worker')
    await flushProtocol()
    const payload = vi.fn()
    await realms[0].installBinding('capturePush', payload)
    FakeWebSocket.commandHandler = (transport, command) => {
      if (command.method === 'Runtime.addBinding') {
        transport.fail(command)
        return true
      }
      if (command.method === 'Runtime.evaluate') {
        transport.respond(command, { result: { type: 'string', value: 'wrong' } }, 'wrong-session')
        transport.respond(command, { exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: denied' } } })
        return true
      }
      return false
    }
    await expect(realms[0].installBinding('capturePush', vi.fn())).rejects.toThrow('Runtime.addBinding failed')
    socket.event('Runtime.bindingCalled', { name: 'capturePush', executionContextId: 1, payload: 'original' }, 'worker-session')
    expect(payload).toHaveBeenCalledExactlyOnceWith('original')
    await expect(realms[0].evaluate('throw new Error("denied")')).rejects.toThrow('Runtime.evaluate exception: Error: denied')
    expect(options.onFailure).toHaveBeenCalledWith(expect.stringContaining('session mismatch'))
  })

  it('uses unique context identities or generations when numeric execution context IDs are reused', async () => {
    const { socket } = await connect()
    socket.attach('worker-session', 'worker', [{ id: 1 }])
    await flushProtocol()
    const original = realms[0]
    socket.event('Runtime.executionContextsCleared', {}, 'worker-session')
    socket.event('Runtime.executionContextCreated', { context: { id: 1 } }, 'worker-session')
    await flushProtocol()
    expect(realms[1].info.realmId).not.toBe(original.info.realmId)
    await expect(original.evaluate('1')).rejects.toThrow('is closed')
    socket.event('Runtime.executionContextCreated', { context: { id: 1, uniqueId: 'replacement-context' } }, 'worker-session')
    await flushProtocol()
    socket.event('Runtime.executionContextDestroyed', { executionContextId: 1, executionContextUniqueId: 'older-context' }, 'worker-session')
    await expect(realms[2].evaluate('undefined')).resolves.toBeUndefined()
    expect(options.onClosed).toHaveBeenCalledTimes(2)
  })

  it('rejects in-flight realm work immediately on context destruction and ignores its late reply after ID reuse', async () => {
    const { socket } = await connect()
    socket.attach('worker-session', 'worker')
    await flushProtocol()
    let heldCommand: SentCommand | undefined
    FakeWebSocket.commandHandler = (_transport, command) => {
      if (command.method !== 'Runtime.evaluate') return false
      heldCommand = command
      return true
    }
    const evaluating = realms[0].evaluate('pendingPromise')
    const rejected = expect(evaluating).rejects.toThrow('is closed')
    await flushProtocol()
    socket.event('Runtime.executionContextDestroyed', { executionContextId: 1 }, 'worker-session')
    await rejected
    FakeWebSocket.commandHandler = null
    socket.event('Runtime.executionContextCreated', { context: { id: 1, uniqueId: 'new-world' } }, 'worker-session')
    await flushProtocol()
    socket.respond(heldCommand!, { result: { type: 'string', value: 'stale-value' } })
    expect(realms).toHaveLength(2)
    await expect(realms[1].evaluate('undefined')).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still resumes a target when consumer callbacks throw', async () => {
    const { socket } = await connect()
    options.onRealm = vi.fn(() => { throw new Error('consumer failed') })
    options.onFailure = vi.fn(() => { throw new Error('reporter failed') })
    socket.attach('worker-session', 'worker', undefined, false)
    await flushProtocol()
    expect(socket.commands.some((command) =>
      command.sessionId === 'worker-session' && command.method === 'Runtime.runIfWaitingForDebugger')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects pending commands and closes every realm exactly once on disconnect', async () => {
    const { router, socket } = await connect()
    socket.attach('worker-session', 'worker')
    await flushProtocol()
    FakeWebSocket.commandHandler = (_transport, command) => command.method === 'Runtime.evaluate'
    const evaluating = realms[0].evaluate('pendingPromise')
    const rejected = expect(evaluating).rejects.toThrow('CDP connection closed')
    socket.close()
    await rejected
    await router.dispose()
    expect(options.onClosed).toHaveBeenCalledExactlyOnceWith(realms[0].info.realmId)
    expect(options.onFailure).toHaveBeenCalledWith(expect.stringContaining('disconnected'))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disposes idempotently, removes known scripts and bindings, disables root attachment and rejects in-flight evaluations', async () => {
    const { router, socket } = await connect()
    socket.attach('page-session', 'page')
    await flushProtocol()
    await realms[0].installBinding('capturePush', vi.fn())
    FakeWebSocket.commandHandler = (_transport, command) => command.method === 'Runtime.evaluate'
    const evaluating = realms[0].evaluate('pendingPromise')
    const rejected = expect(evaluating).rejects.toThrow('router disposed')
    const disposing = router.dispose()
    expect(router.dispose()).toBe(disposing)
    await disposing
    await rejected
    expect(socket.commands).toContainEqual(expect.objectContaining({
      method: 'Page.removeScriptToEvaluateOnNewDocument', sessionId: 'page-session', params: { identifier: 'init-page-session' }
    }))
    expect(socket.commands).toContainEqual(expect.objectContaining({
      method: 'Runtime.removeBinding', sessionId: 'page-session', params: { name: 'capturePush' }
    }))
    expect(socket.commands).toContainEqual(expect.objectContaining({
      method: 'Target.setAutoAttach', params: { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }
    }))
    expect(socket.readyState).toBe(3)
    expect(vi.getTimerCount()).toBe(0)
    await expect(realms[0].installBinding('capturePush', vi.fn())).rejects.toThrow('is closed')
  })

  it('releases a target during in-flight setup and bounds root cleanup even when cleanup responses never arrive', async () => {
    const { router, socket } = await connect()
    FakeWebSocket.commandHandler = (_transport, command) =>
      (command.method === 'Target.setAutoAttach' && command.sessionId === 'worker-session') ||
      (command.method === 'Target.setAutoAttach' && command.params.autoAttach === false) ||
      (command.method === 'Target.setDiscoverTargets' && command.params.discover === false)
    socket.attach('worker-session', 'worker')
    await flushProtocol()
    const disposing = router.dispose()
    await flushProtocol()
    expect(socket.commands).toContainEqual(expect.objectContaining({
      method: 'Runtime.runIfWaitingForDebugger', sessionId: 'worker-session'
    }))
    await vi.advanceTimersByTimeAsync(3_000)
    await disposing
    expect(socket.readyState).toBe(3)
    expect(options.onFailure).toHaveBeenCalledWith(expect.stringContaining('Root CDP cleanup failed'))
    expect(vi.getTimerCount()).toBe(0)
  })
})
