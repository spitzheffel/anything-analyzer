import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CAPTURE_ENTRY_SCRIPT_FLAG } from '../../shared/capture-protocol'
import type { CaptureRealmInfo, CaptureRealmKind } from '../../shared/capture-protocol'

export interface CaptureRealmConnection {
  info: CaptureRealmInfo
  evaluate<T>(expression: string): Promise<T>
  installBinding(name: string, onPayload: (payload: string) => void): Promise<void>
}

export interface CloakRealmRouterOptions {
  bootstrapSource: string
  expectedTargetId?: string
  onRealm: (realm: CaptureRealmConnection) => void
  onClosed: (realmId: string) => void
  onFailure: (reason: string) => void
}

type CapabilityState = 'unknown' | 'supported' | 'degraded'

/** Conservative observed CDP support, not a replacement for producer health checks. */
export interface CloakRealmRouterCapabilities {
  flatAutoAttach: boolean
  targetDiscovery: boolean
  workerScriptRewriting: boolean
  recursiveAutoAttach: CapabilityState
  documentInitScript: CapabilityState
  workerStartupInjection: CapabilityState
}

const COMMAND_TIMEOUT_MS = 3_000
const ENDPOINT_TIMEOUT_MS = 5_000
const SETUP_TIMEOUT_MS = 10_000
const PAUSE_GUARD_TIMEOUT_MS = 5_000
const WORKER_BOOTSTRAP_SOURCE_URL = 'aa-capture-bootstrap://realm-router/bootstrap.js'
/**
 * A module worker instantiates its module graph before it evaluates any top
 * level code, so its execution context exists for a short while before the
 * rewritten entry script's first statement runs. Reading the marker once, at
 * context creation, lands inside that window often enough to matter: measured
 * at 2 failures in 12 real-Cloak runs, each reporting a coverage gap for a
 * worker whose bytes the router had demonstrably rewritten. Re-read for a
 * bounded moment instead. Only the verdict waits — the re-entry bootstrap has
 * already installed the hooks by then, so nothing runs uninstrumented.
 */
const ENTRY_MARKER_POLL_ATTEMPTS = 10
const ENTRY_MARKER_POLL_INTERVAL_MS = 5
/**
 * Worker entry scripts are fetched as `Other`, not `Script` — measured across
 * dedicated, shared and service workers, classic and module. Filtering on
 * `Script` would miss every one of them; filtering on `*` would route every
 * response in the browser through this process. `Other` is the narrow set that
 * actually contains them.
 */
const WORKER_SCRIPT_FETCH_PATTERNS = [
  { urlPattern: '*', requestStage: 'Response', resourceType: 'Other' }
]
const SCRIPT_MEDIA_TYPE_PATTERN = /(?:^|\/|\+)(?:javascript|ecmascript|jscript)\b/i
const SCRIPT_PATH_PATTERN = /\.[cm]?js(?:$|[?#])/i
const TARGET_FILTER = [
  { type: 'page' },
  { type: 'iframe' },
  { type: 'worker' },
  { type: 'shared_worker' },
  { type: 'service_worker' },
  { exclude: true }
]

interface ProtocolMessage {
  id?: number
  method?: string
  sessionId?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

interface PendingCommand {
  method: string
  sessionId: string | undefined
  contextId: number | undefined
  timer: ReturnType<typeof setTimeout>
  resolve: (result: Record<string, unknown>) => void
  reject: (error: Error) => void
}

interface RealmState {
  contextId: number
  realmId: string
  uniqueId: string | undefined
  frameId: string | null
  createdAfterRegistration: boolean
  active: boolean
  initializing: boolean
  reported: boolean
  bindings: Map<string, (payload: string) => void>
}

/**
 * A worker's first-statement coverage is a fact about its entry script, not a
 * race the router can win.
 *
 * `Target.attachedToTarget` reports `waitingForDebugger: true` for a shared
 * worker whose entry script has *already run to completion* — measured, not
 * assumed — so no breakpoint, instrumentation pause or evaluate ordering can
 * reach its first statement. What does reach it is rewriting the script the
 * worker loads: the router prepends the bootstrap to the response body, so the
 * bootstrap literally is the entry script's first statement.
 *
 * Coverage is therefore evidence, not intent, and the evidence lives in the
 * realm: the rewritten bytes set a marker the router reads back from the
 * instance in front of it. Having rewritten that URL earlier is a weaker
 * claim — a service worker can start again from its script cache without
 * re-fetching, so a later instance may be running a copy the router never saw.
 */
interface WorkerEntry {
  url: string
}

interface TargetSession {
  sessionId: string
  parentSessionId: string | undefined
  targetId: string
  kind: CaptureRealmKind | null
  generation: number
  waitingForDebugger: boolean
  resumeStarted: boolean
  resumePromise: Promise<void> | null
  scriptIdentifier: string | null
  runtimeEnabled: boolean
  runtimeEnablePromise: Promise<void> | null
  workerEntry: WorkerEntry | null
  acceptingContexts: boolean
  active: boolean
  pauseGuard: ReturnType<typeof setTimeout> | null
  realms: Map<number, RealmState>
  initializingContexts: Set<Promise<void>>
  bindingNames: Set<string>
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function traceRouterEvent(message: string): void {
  if (process.env.AA_CLOAK_TRACE === '1') console.error(`[CloakRealmRouter] ${message}`)
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${description} timed out`)), timeoutMs)
    work.then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function parseDevToolsEndpoint(contents: string): string {
  // Accept only Chromium's port + browser-path file, never a supplied host or URL.
  const match = /^(\d{1,5})\r?\n(\/devtools\/browser\/[A-Za-z0-9_-]+)(?:\r?\n)?$/.exec(contents)
  if (!match) throw new Error('Invalid DevToolsActivePort browser endpoint')
  const port = Number(match[1])
  if (port < 1 || port > 65_535) throw new Error('Invalid DevToolsActivePort loopback port')
  const endpoint = `ws://127.0.0.1:${port}${match[2]}`
  const parsed = new URL(endpoint)
  if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1' ||
      parsed.pathname !== match[2] || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('DevToolsActivePort must identify an exact loopback browser endpoint')
  }
  return endpoint
}

async function discoverDevToolsEndpoint(userDataDir: string): Promise<string> {
  const controller = new AbortController()
  const deadline = Date.now() + ENDPOINT_TIMEOUT_MS
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  const reading = (async () => {
    while (!controller.signal.aborted && Date.now() < deadline) {
      try {
        const contents = await readFile(join(userDataDir, 'DevToolsActivePort'), {
          encoding: 'utf8', signal: controller.signal
        })
        return parseDevToolsEndpoint(contents)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'EBUSY') throw error
      }
      await new Promise<void>((resolve) => {
        const finishRetry = (): void => {
          if (retryTimer !== undefined) clearTimeout(retryTimer)
          controller.signal.removeEventListener('abort', finishRetry)
          resolve()
        }
        controller.signal.addEventListener('abort', finishRetry, { once: true })
        retryTimer = setTimeout(finishRetry, 50)
        if (controller.signal.aborted) finishRetry()
      })
    }
    throw new Error('Waiting for DevToolsActivePort timed out')
  })()
  try {
    return await withDeadline(reading, ENDPOINT_TIMEOUT_MS, 'Waiting for DevToolsActivePort')
  } finally {
    controller.abort()
    if (retryTimer !== undefined) clearTimeout(retryTimer)
  }
}

/**
 * Serve the rewritten script under the headers the site actually sent.
 *
 * Only the two the rewrite invalidates are dropped: the body is longer than
 * `content-length` says, and `Fetch.getResponseBody` already decoded whatever
 * `content-encoding` named. Everything else has to survive — `Service-Worker-
 * Allowed` widens a worker's scope, and CORS, CSP and COEP headers decide
 * whether the script is allowed to run at all. Replacing them would change how
 * the page behaves under observation.
 */
function rewrittenResponseHeaders(headers: unknown): Array<{ name: string; value: string }> {
  const dropped = new Set(['content-length', 'content-encoding'])
  const preserved: Array<{ name: string; value: string }> = []
  for (const header of Array.isArray(headers) ? headers : []) {
    const entry = header as { name?: unknown; value?: unknown }
    if (typeof entry.name !== 'string' || typeof entry.value !== 'string') continue
    if (dropped.has(entry.name.toLowerCase())) continue
    preserved.push({ name: entry.name, value: entry.value })
  }
  return preserved
}

function getRealmKind(targetType: unknown): CaptureRealmKind | null {
  if (targetType === 'page' || targetType === 'iframe') return 'document'
  if (targetType === 'worker' || targetType === 'shared_worker' || targetType === 'service_worker') {
    return targetType
  }
  return null
}

/** Owns a separate browser-level, flattened CDP connection; never uses Playwright internals. */
export class CloakRealmRouter {
  private readonly pendingCommands = new Map<number, PendingCommand>()
  private readonly sessions = new Map<string, TargetSession>()
  private readonly capabilityState: CloakRealmRouterCapabilities = {
    flatAutoAttach: false,
    targetDiscovery: false,
    workerScriptRewriting: false,
    recursiveAutoAttach: 'unknown',
    documentInitScript: 'unknown',
    workerStartupInjection: 'unknown'
  }
  private nextCommandId = 1
  private nextGeneration = 1
  private closed = false
  private disposing = false
  private disposalPromise: Promise<void> | null = null

  private constructor(private readonly socket: WebSocket, private readonly options: CloakRealmRouterOptions) {
    socket.addEventListener('message', this.handleMessage)
    socket.addEventListener('close', this.handleSocketClose)
    socket.addEventListener('error', this.handleSocketError)
  }

  static async connect(userDataDir: string, options: CloakRealmRouterOptions): Promise<CloakRealmRouter> {
    let router: CloakRealmRouter | undefined
    try {
      const endpoint = await discoverDevToolsEndpoint(userDataDir)
      if (typeof globalThis.WebSocket !== 'function') {
        throw new Error('Node global WebSocket is unavailable; Electron Node 22 is required')
      }
      router = new CloakRealmRouter(new globalThis.WebSocket(endpoint), options)
      await withDeadline(router.initialize(), SETUP_TIMEOUT_MS, 'Cloak realm router setup')
      return router
    } catch (error) {
      if (router) {
        router.reportFailure(`Cloak realm router connection failed: ${describeError(error)}`)
        await router.dispose()
      } else {
        try { options.onFailure(`Cloak realm router connection failed: ${describeError(error)}`) } catch { /* Consumer isolation. */ }
      }
      throw error
    }
  }

  get capabilities(): Readonly<CloakRealmRouterCapabilities> {
    return Object.freeze({ ...this.capabilityState })
  }

  private async initialize(): Promise<void> {
    await this.waitForSocketOpen()
    if (this.options.expectedTargetId) {
      const discovered = await this.sendCommand('Target.getTargets')
      const targetInfos = discovered.targetInfos as Array<{ targetId?: string }> | undefined
      if (!targetInfos?.some(target => target.targetId === this.options.expectedTargetId)) {
        throw new Error('The loopback CDP endpoint does not belong to the expected Cloak browser')
      }
    }
    // Arm script rewriting before auto-attach: a worker whose entry script is
    // already in flight cannot be covered afterwards.
    try {
      await this.sendCommand('Fetch.enable', { patterns: WORKER_SCRIPT_FETCH_PATTERNS })
      this.capabilityState.workerScriptRewriting = true
    } catch (error) {
      this.capabilityState.workerScriptRewriting = false
      this.reportFailure(`Worker entry-script rewriting unavailable: ${describeError(error)}`)
    }
    await this.sendCommand('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: TARGET_FILTER
    })
    this.capabilityState.flatAutoAttach = true
    await this.sendCommand('Target.setDiscoverTargets', { discover: true, filter: TARGET_FILTER })
    this.capabilityState.targetDiscovery = true
  }

  private async waitForSocketOpen(): Promise<void> {
    if (this.socket.readyState === 1) return
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        this.socket.removeEventListener('open', onOpen)
        this.socket.removeEventListener('close', onClose)
        this.socket.removeEventListener('error', onError)
        if (error) reject(error)
        else resolve()
      }
      const onOpen = (): void => finish()
      const onClose = (): void => finish(new Error('CDP WebSocket closed before connecting'))
      const onError = (): void => finish(new Error('CDP WebSocket failed before connecting'))
      const timer = setTimeout(() => finish(new Error('CDP WebSocket connection timed out')), COMMAND_TIMEOUT_MS)
      this.socket.addEventListener('open', onOpen)
      this.socket.addEventListener('close', onClose)
      this.socket.addEventListener('error', onError)
      if (this.closed || this.socket.readyState > 1) onClose()
    })
  }

  private sendCommand(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    allowDuringDispose = false
  ): Promise<Record<string, unknown>> {
    if (this.closed || (this.disposing && !allowDuringDispose) || this.socket.readyState !== 1) {
      return Promise.reject(new Error(`Cannot send ${method}: CDP connection is closed`))
    }
    const commandId = this.nextCommandId++
    if (process.env.AA_CLOAK_TRACE === '1' && sessionId) {
      traceRouterEvent(`command session=${sessionId} method=${method}`)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(commandId)
        reject(new Error(`${method} timed out${sessionId ? ` in session ${sessionId}` : ''}`))
      }, COMMAND_TIMEOUT_MS)
      const contextId = method === 'Runtime.evaluate' ? params.contextId : params.executionContextId
      this.pendingCommands.set(commandId, {
        method, sessionId, contextId: typeof contextId === 'number' ? contextId : undefined,
        timer, resolve, reject
      })
      try {
        this.socket.send(JSON.stringify({ id: commandId, method, params, ...(sessionId ? { sessionId } : {}) }))
      } catch (error) {
        clearTimeout(timer)
        this.pendingCommands.delete(commandId)
        reject(new Error(`${method} could not be sent: ${describeError(error)}`))
      }
    })
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    if (this.closed) return
    let message: ProtocolMessage
    try {
      if (typeof event.data !== 'string') throw new Error('Expected a text CDP message')
      const parsed: unknown = JSON.parse(event.data)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid CDP message')
      message = parsed as ProtocolMessage
    } catch (error) {
      this.reportFailure(`Invalid CDP transport message: ${describeError(error)}`)
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.pendingCommands.get(message.id)
      if (!pending) return // Timed-out and duplicate responses must never affect a newer request.
      if (message.sessionId !== pending.sessionId) {
        this.reportFailure(`CDP response session mismatch for ${pending.method}`)
        return
      }
      clearTimeout(pending.timer)
      this.pendingCommands.delete(message.id)
      if (message.error) pending.reject(new Error(`${pending.method} failed (${message.error.code}): ${message.error.message}`))
      else pending.resolve(message.result ?? {})
      return
    }
    const parameters = message.params ?? {}
    if (message.method === 'Fetch.requestPaused') {
      void this.rewriteInterceptedScript(parameters, message.sessionId)
      return
    }
    if (message.method === 'Target.attachedToTarget') {
      const targetInfo = parameters.targetInfo as { targetId?: unknown; type?: unknown; url?: unknown } | undefined
      traceRouterEvent(`attached session=${String(parameters.sessionId)} target=${String(targetInfo?.targetId)} parent=${String(message.sessionId)} type=${String(targetInfo?.type)} waiting=${String(parameters.waitingForDebugger === true)}`)
      this.attachTarget(parameters, message.sessionId)
      return
    }
    if (message.method === 'Target.detachedFromTarget' && typeof parameters.sessionId === 'string') {
      traceRouterEvent(`detached session=${parameters.sessionId} target=${String(this.sessions.get(parameters.sessionId)?.targetId)} kind=${String(this.sessions.get(parameters.sessionId)?.kind)}`)
      this.closeSession(parameters.sessionId)
      return
    }
    if (message.method === 'Target.targetDestroyed' && typeof parameters.targetId === 'string') {
      for (const target of [...this.sessions.values()]) {
        if (target.targetId === parameters.targetId) this.closeSession(target.sessionId)
      }
      return
    }
    const target = message.sessionId ? this.sessions.get(message.sessionId) : undefined
    if (!target || !target.active) return
    if (message.method === 'Runtime.executionContextCreated') this.createContext(target, parameters.context)
    else if (message.method === 'Runtime.executionContextsCleared') {
      for (const realm of [...target.realms.values()]) this.closeRealm(target, realm)
    } else if (message.method === 'Runtime.executionContextDestroyed') {
      const realm = target.realms.get(parameters.executionContextId as number)
      if (realm && (!parameters.executionContextUniqueId || parameters.executionContextUniqueId === realm.uniqueId)) {
        this.closeRealm(target, realm)
      }
    } else if (message.method === 'Runtime.bindingCalled') {
      const realm = target.realms.get(parameters.executionContextId as number)
      const callback = realm?.bindings.get(parameters.name as string)
      if (realm?.active && callback && typeof parameters.payload === 'string') {
        try { callback(parameters.payload) } catch (error) {
          this.reportFailure(`Realm binding callback failed: ${describeError(error)}`)
        }
      }
    }
  }

  /**
   * Prepend the bootstrap to an intercepted worker entry script so it becomes
   * the script's first statement. Holding the response here also keeps the
   * worker from starting before the router has attached to it, but the rewrite
   * — not that ordering — is what makes first-statement coverage a fact.
   */
  private async rewriteInterceptedScript(
    parameters: Record<string, unknown>, sessionId?: string
  ): Promise<void> {
    const requestId = parameters.requestId
    if (typeof requestId !== 'string') return
    const request = parameters.request as { url?: unknown } | undefined
    const url = typeof request?.url === 'string' ? request.url : ''
    const release = (): Promise<unknown> =>
      this.sendCommand('Fetch.continueRequest', { requestId }, sessionId, true)
        .catch((error: unknown) => {
          // A request that outlived its target is already gone; nothing to release.
          if (!this.closed) traceRouterEvent(`continueRequest failed for ${url}: ${describeError(error)}`)
        })
    // Request-stage interceptions carry no status code; only responses can be rewritten.
    if (parameters.responseStatusCode === undefined || !this.looksLikeScript(parameters, url)) {
      traceRouterEvent(`released without rewriting ${url} ` +
        `(status=${String(parameters.responseStatusCode)} type=${String(parameters.resourceType)})`)
      await release()
      return
    }
    try {
      const body = await this.sendCommand('Fetch.getResponseBody', { requestId }, sessionId)
      const encoded = typeof body.body === 'string' ? body.body : ''
      const original = body.base64Encoded === true
        ? Buffer.from(encoded, 'base64').toString('utf8')
        : encoded
      // The marker rides with these bytes, so the realm that runs them can be
      // asked directly whether it started rewritten.
      const patched = `globalThis[${JSON.stringify(CAPTURE_ENTRY_SCRIPT_FLAG)}]=true;\n` +
        `${this.options.bootstrapSource}\n;${original}`
      await this.sendCommand('Fetch.fulfillRequest', {
        requestId,
        responseCode: typeof parameters.responseStatusCode === 'number' ? parameters.responseStatusCode : 200,
        responseHeaders: rewrittenResponseHeaders(parameters.responseHeaders),
        body: Buffer.from(patched, 'utf8').toString('base64')
      }, sessionId)
      traceRouterEvent(`rewrote entry script ${url}`)
    } catch (error) {
      // Never strand the request: an unrewritten worker still runs, and the
      // realm it creates reports the missing coverage rather than claiming it.
      this.reportFailure(`Worker entry-script rewrite failed for ${url}: ${describeError(error)}`)
      await release()
    }
  }

  private looksLikeScript(parameters: Record<string, unknown>, url: string): boolean {
    const headers = parameters.responseHeaders as Array<{ name?: unknown; value?: unknown }> | undefined
    for (const header of headers ?? []) {
      if (typeof header.name !== 'string' || header.name.toLowerCase() !== 'content-type') continue
      if (typeof header.value === 'string') return SCRIPT_MEDIA_TYPE_PATTERN.test(header.value)
    }
    return SCRIPT_PATH_PATTERN.test(url)
  }

  private attachTarget(parameters: Record<string, unknown>, parentSessionId?: string): void {
    if (typeof parameters.sessionId !== 'string' || this.sessions.has(parameters.sessionId)) return
    const targetInfo = parameters.targetInfo as { targetId?: unknown; type?: unknown; url?: unknown } | undefined
    const hasNativeTargetId = typeof targetInfo?.targetId === 'string'
    if (!hasNativeTargetId) this.reportFailure(`Attached CDP session ${parameters.sessionId} has no native target identifier`)
    const realmKind = hasNativeTargetId ? getRealmKind(targetInfo?.type) : null
    const entryUrl = typeof targetInfo?.url === 'string' ? targetInfo.url : ''
    const workerEntry: WorkerEntry | null = realmKind && realmKind !== 'document'
      ? { url: entryUrl }
      : null
    const target: TargetSession = {
      sessionId: parameters.sessionId,
      parentSessionId,
      targetId: typeof targetInfo?.targetId === 'string' ? targetInfo.targetId : parameters.sessionId,
      kind: realmKind,
      generation: this.nextGeneration++,
      waitingForDebugger: parameters.waitingForDebugger === true,
      resumeStarted: false,
      resumePromise: null,
      scriptIdentifier: null,
      runtimeEnabled: false,
      runtimeEnablePromise: null,
      workerEntry,
      acceptingContexts: false,
      active: true,
      pauseGuard: null,
      realms: new Map(),
      initializingContexts: new Set(),
      bindingNames: new Set()
    }
    this.sessions.set(target.sessionId, target)
    target.pauseGuard = setTimeout(() => {
      target.pauseGuard = null
      this.reportFailure(`Target ${target.targetId} setup exceeded the pause guard; resuming without an early-injection guarantee`)
      void this.resumeTarget(target)
    }, PAUSE_GUARD_TIMEOUT_MS)
    void this.initializeTarget(target)
  }

  private async initializeTarget(target: TargetSession): Promise<void> {
    try {
      if (!target.kind || this.disposing) return
      if (!target.waitingForDebugger && target.kind === 'document') {
        this.reportFailure(`Late attachment to document target ${target.targetId}: startup injection was not guaranteed`)
      }
      try {
        await this.sendCommand('Target.setAutoAttach', {
          autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: TARGET_FILTER
        }, target.sessionId)
        this.recordCapability('recursiveAutoAttach', true)
      } catch (error) {
        this.recordCapability('recursiveAutoAttach', false)
        this.reportFailure(`Recursive auto-attach unavailable for ${target.targetId}: ${describeError(error)}`)
      }
      if (!target.active || this.disposing || this.closed) return
      if (target.kind === 'document') {
        try {
          const registration = await this.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
            source: this.options.bootstrapSource
          }, target.sessionId)
          if (typeof registration.identifier !== 'string') throw new Error('CDP returned no document init-script identifier')
          target.scriptIdentifier = registration.identifier
          this.recordCapability('documentInitScript', true)
        } catch (error) {
          this.recordCapability('documentInitScript', false)
          this.reportFailure(`Document init-script registration failed for ${target.targetId}: ${describeError(error)}`)
        }
      }
      if (!target.active || this.disposing || this.closed) return
      if (target.kind !== 'document') {
        // A service worker registered from scratch attaches before its script
        // is even requested: no execution context, no running message loop, so
        // Runtime.enable cannot answer until the target is resumed. Waiting for
        // it first deadlocks until the command deadline and strands the realm.
        // Resuming first costs nothing now that a worker's coverage lives in
        // its rewritten entry script rather than in winning this race.
        await this.resumeTarget(target)
        if (!target.active || this.disposing || this.closed) return
        await this.enableTargetRuntime(target)
        return
      }
      await this.enableTargetRuntime(target)
      while (target.initializingContexts.size > 0 && !target.resumeStarted && target.active && !this.disposing) {
        await Promise.all([...target.initializingContexts])
      }
    } catch (error) {
      if (target.active && !this.disposing && !this.closed) {
        this.reportFailure(`Realm setup failed for ${target.targetId}: ${describeError(error)}`)
      }
    } finally {
      // Even unsupported targets and failed setup must be released.
      await this.resumeTarget(target)
    }
  }

  private enableTargetRuntime(target: TargetSession): Promise<void> {
    if (target.runtimeEnablePromise) return target.runtimeEnablePromise
    target.runtimeEnablePromise = this.sendCommand('Runtime.enable', {}, target.sessionId).then(() => {
      target.runtimeEnabled = true
      target.acceptingContexts = true
      for (const realm of target.realms.values()) this.startContext(target, realm)
    })
    return target.runtimeEnablePromise
  }

  private async detachStalledTarget(target: TargetSession, reason: string): Promise<void> {
    if (this.closed || !target.active) return
    this.reportFailure(`Could not resume target ${target.targetId}: ${reason}`)
    try {
      await this.sendCommand('Target.detachFromTarget', { sessionId: target.sessionId }, undefined, true)
    } catch (error) {
      this.reportFailure(`Could not detach stalled target ${target.targetId}: ${describeError(error)}`)
      this.finishClose()
    }
    this.closeSession(target.sessionId)
  }

  private resumeTarget(target: TargetSession): Promise<void> {
    if (target.resumePromise) return target.resumePromise
    target.resumeStarted = true
    if (target.pauseGuard !== null) clearTimeout(target.pauseGuard)
    target.pauseGuard = null
    target.resumePromise = this.sendCommand('Runtime.runIfWaitingForDebugger', {}, target.sessionId, true)
      .then(() => undefined)
      .catch((error: unknown) => this.detachStalledTarget(target, describeError(error)))
    return target.resumePromise
  }

  private createContext(target: TargetSession, contextValue: unknown): void {
    if (!target.kind || !contextValue || typeof contextValue !== 'object' || this.disposing) return
    const context = contextValue as { id?: unknown; uniqueId?: unknown; auxData?: { isDefault?: unknown; frameId?: unknown } }
    if (typeof context.id !== 'number') return
    if (target.kind === 'document' && context.auxData?.isDefault !== true) return
    const uniqueId = typeof context.uniqueId === 'string' ? context.uniqueId : undefined
    const previous = target.realms.get(context.id)
    if (previous) {
      if (uniqueId && previous.uniqueId === uniqueId) return
      this.closeRealm(target, previous)
    }
    const identity = uniqueId ?? `generation-${target.generation}-${this.nextGeneration++}`
    const realm: RealmState = {
      contextId: context.id,
      realmId: `cdp:${encodeURIComponent(target.targetId)}:${encodeURIComponent(identity)}`,
      uniqueId,
      frameId: typeof context.auxData?.frameId === 'string' ? context.auxData.frameId : null,
      createdAfterRegistration: target.runtimeEnabled && target.scriptIdentifier !== null,
      active: true,
      initializing: false,
      reported: false,
      bindings: new Map()
    }
    target.realms.set(realm.contextId, realm)
    if (target.acceptingContexts) this.startContext(target, realm)
  }

  private startContext(target: TargetSession, realm: RealmState): void {
    if (realm.initializing || realm.reported || !realm.active) return
    realm.initializing = true
    const initializing = this.initializeContext(target, realm)
    target.initializingContexts.add(initializing)
    void initializing.then(
      () => target.initializingContexts.delete(initializing),
      (error: unknown) => {
        target.initializingContexts.delete(initializing)
        this.reportFailure(`Realm initialization failed for ${realm.realmId}: ${describeError(error)}`)
      }
    )
  }

  private async initializeContext(target: TargetSession, realm: RealmState): Promise<void> {
    let bootstrapInstalled = false
    let entryScriptRewritten = false
    const startedWhilePaused = target.waitingForDebugger && !target.resumeStarted
    try {
      // For a worker, install first and read the entry-script marker second,
      // still in one round trip. Installing first puts the hooks in place at
      // the earliest moment the router can manage, whatever the marker turns
      // out to say; only the coverage verdict waits. The re-entry is idempotent
      // and never sets the marker itself — only the bytes the router rewrote
      // do — so reading it afterwards still reports on the entry script alone.
      // The re-entry exists to bind the producer to this run, since the bytes
      // the worker started from carry whatever runId was current when they
      // were rewritten.
      const marker = `globalThis[${JSON.stringify(CAPTURE_ENTRY_SCRIPT_FLAG)}] === true`
      const bootstrapExpression = target.workerEntry
        ? `(async () => {\n${this.options.bootstrapSource}\n;\n` +
          `let covered = ${marker}\n` +
          `for (let attempt = 0; attempt < ${ENTRY_MARKER_POLL_ATTEMPTS} && !covered; attempt += 1) {\n` +
          `  await new Promise(resolve => setTimeout(resolve, ${ENTRY_MARKER_POLL_INTERVAL_MS}))\n` +
          `  covered = ${marker}\n` +
          `}\nreturn covered })()\n` +
          `//# sourceURL=${WORKER_BOOTSTRAP_SOURCE_URL}`
        : this.options.bootstrapSource
      const evaluated = await this.evaluateInRealm<unknown>(target, realm, bootstrapExpression)
      entryScriptRewritten = evaluated === true
      bootstrapInstalled = true
    } catch (error) {
      if (realm.active && !this.disposing && !this.closed) {
        this.reportFailure(`Bootstrap failed in realm ${realm.realmId}: ${describeError(error)}`)
      }
    }
    const realmKind = target.kind
    if (!realm.active || !target.active || this.closed || this.disposing || realmKind === null) return
    const injectedBeforeResume = startedWhilePaused && !target.resumeStarted
    const documentHasStartupCoverage = target.scriptIdentifier !== null &&
      (realm.createdAfterRegistration || injectedBeforeResume)
    // A worker is covered from its first statement exactly when the instance
    // in front of us started from rewritten bytes. Having rewritten that URL
    // earlier is not the same claim: a service worker can start again from its
    // script cache without re-fetching, so a later instance may be running a
    // copy the router never saw.
    const entry = target.workerEntry
    const earlyInjection = bootstrapInstalled &&
      (realmKind === 'document' ? documentHasStartupCoverage : entryScriptRewritten)
    if (realmKind !== 'document') {
      this.recordCapability('workerStartupInjection', earlyInjection)
      if (!entryScriptRewritten) {
        this.reportFailure(
          `Worker entry script was not rewritten for ${target.targetId} (${entry?.url || 'unknown URL'}); ` +
          'its first statements ran without instrumentation'
        )
      }
    }
    const info: CaptureRealmInfo = {
      realmId: realm.realmId,
      kind: realmKind,
      targetId: target.targetId,
      frameId: realm.frameId,
      tabId: null,
      earlyInjection
    }
    realm.reported = true
    try {
      this.options.onRealm({
        info,
        evaluate: <T>(expression: string) => this.evaluateInRealm<T>(target, realm, expression),
        installBinding: (name, onPayload) => this.installRealmBinding(target, realm, name, onPayload)
      })
    } catch (error) {
      this.reportFailure(`Realm callback failed for ${realm.realmId}: ${describeError(error)}`)
    }
  }

  private assertRealmActive(target: TargetSession, realm: RealmState): void {
    if (this.closed || this.disposing || !target.active || !realm.active || target.realms.get(realm.contextId) !== realm) {
      throw new Error(`Capture realm ${realm.realmId} is closed`)
    }
  }

  private async evaluateInRealm<T>(target: TargetSession, realm: RealmState, expression: string): Promise<T> {
    this.assertRealmActive(target, realm)
    const response = await this.sendCommand('Runtime.evaluate', {
      expression, contextId: realm.contextId, awaitPromise: true, returnByValue: true
    }, target.sessionId)
    this.assertRealmActive(target, realm)
    if (response.exceptionDetails) {
      const details = response.exceptionDetails as { text?: string; exception?: { description?: string } }
      throw new Error(`Runtime.evaluate exception: ${details.exception?.description ?? details.text ?? 'unknown exception'}`)
    }
    const remoteResult = response.result as { type?: string; value?: unknown; unserializableValue?: string } | undefined
    if (!remoteResult) throw new Error('Runtime.evaluate returned no result')
    if ('value' in remoteResult) return remoteResult.value as T
    if (remoteResult.type === 'undefined') return undefined as T
    const specialValue = remoteResult.unserializableValue
    if (specialValue === 'NaN') return Number.NaN as T
    if (specialValue === 'Infinity') return Number.POSITIVE_INFINITY as T
    if (specialValue === '-Infinity') return Number.NEGATIVE_INFINITY as T
    if (specialValue === '-0') return -0 as T
    if (specialValue && /^-?\d+n$/.test(specialValue)) return BigInt(specialValue.slice(0, -1)) as T
    throw new Error('Runtime.evaluate result is not serializable by value')
  }

  private async installRealmBinding(
    target: TargetSession, realm: RealmState, name: string, onPayload: (payload: string) => void
  ): Promise<void> {
    this.assertRealmActive(target, realm)
    if (!name) throw new Error('Capture binding name must not be empty')
    const previous = realm.bindings.get(name)
    realm.bindings.set(name, onPayload)
    target.bindingNames.add(name)
    try {
      // Per context, deliberately. A session-scoped binding (no
      // executionContextId) does not reach the contexts a later navigation
      // creates in this Chromium: measured at 19 of 30 navigations left with
      // no transport at all, against 3 of 30 losing the per-context race.
      await this.sendCommand('Runtime.addBinding', { name, executionContextId: realm.contextId }, target.sessionId)
      this.assertRealmActive(target, realm)
    } catch (error) {
      if (realm.active && realm.bindings.get(name) === onPayload) {
        if (previous) realm.bindings.set(name, previous)
        else realm.bindings.delete(name)
      }
      throw error
    }
  }

  private closeRealm(target: TargetSession, realm: RealmState): void {
    if (!realm.active) return
    realm.active = false
    realm.bindings.clear()
    if (target.realms.get(realm.contextId) === realm) target.realms.delete(realm.contextId)
    for (const [commandId, pending] of this.pendingCommands) {
      if (pending.sessionId === target.sessionId && pending.contextId === realm.contextId) {
        clearTimeout(pending.timer)
        this.pendingCommands.delete(commandId)
        pending.reject(new Error(`${pending.method}: capture realm ${realm.realmId} is closed`))
      }
    }
    if (realm.reported && !this.realmObservedElsewhere(target, realm)) {
      try { this.options.onClosed(realm.realmId) } catch (error) {
        this.reportFailure(`Realm close callback failed: ${describeError(error)}`)
      }
    }
  }

  /**
   * A worker target is attached once per parent that auto-attaches: the same
   * target, the same execution context, and therefore the same realm id, seen
   * through several sessions. Losing one of those views is not the realm going
   * away — a page that closes takes its session with it while the service
   * worker it spoke to keeps running and keeps queueing. Report a closure only
   * when no live session can still see the realm, or the host seals a realm
   * that is still producing and ignores everything it sends afterwards.
   */
  private realmObservedElsewhere(closing: TargetSession, realm: RealmState): boolean {
    for (const other of this.sessions.values()) {
      if (other === closing || !other.active || other.targetId !== closing.targetId) continue
      for (const candidate of other.realms.values()) {
        if (candidate.active && candidate.realmId === realm.realmId) return true
      }
    }
    return false
  }

  private closeSession(sessionId: string): void {
    const target = this.sessions.get(sessionId)
    if (!target) return
    target.active = false
    if (target.pauseGuard !== null) clearTimeout(target.pauseGuard)
    target.pauseGuard = null
    this.sessions.delete(sessionId)
    for (const realm of [...target.realms.values()]) this.closeRealm(target, realm)
    for (const [commandId, pending] of this.pendingCommands) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timer)
        this.pendingCommands.delete(commandId)
        pending.reject(new Error(`${pending.method}: target session ${sessionId} detached`))
      }
    }
    for (const child of [...this.sessions.values()]) {
      if (child.parentSessionId === sessionId) this.closeSession(child.sessionId)
    }
  }

  private recordCapability(name: 'recursiveAutoAttach' | 'documentInitScript' | 'workerStartupInjection', supported: boolean): void {
    if (!supported) this.capabilityState[name] = 'degraded'
    else if (this.capabilityState[name] === 'unknown') this.capabilityState[name] = 'supported'
  }

  private reportFailure(reason: string): void {
    try { this.options.onFailure(reason) } catch { /* Failure reporting must not prevent debugger release. */ }
  }

  private readonly handleSocketClose = (): void => {
    if (!this.disposing && !this.closed) this.reportFailure('CDP WebSocket disconnected; realm coverage is unavailable')
    this.finishClose()
  }

  private readonly handleSocketError = (): void => {
    if (!this.disposing && !this.closed) this.reportFailure('CDP WebSocket transport failed; realm coverage is unavailable')
    this.finishClose()
  }

  private rejectPending(reason: string): void {
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`${pending.method}: ${reason}`))
    }
    this.pendingCommands.clear()
  }

  private finishClose(): void {
    if (this.closed) return
    this.closed = true
    this.capabilityState.flatAutoAttach = false
    this.capabilityState.targetDiscovery = false
    this.rejectPending('CDP connection closed')
    for (const target of [...this.sessions.values()]) this.closeSession(target.sessionId)
    this.socket.removeEventListener('message', this.handleMessage)
    this.socket.removeEventListener('close', this.handleSocketClose)
    this.socket.removeEventListener('error', this.handleSocketError)
    try { if (this.socket.readyState < 2) this.socket.close() } catch { /* Already disconnected. */ }
  }

  dispose(): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise
    this.disposing = true
    this.rejectPending('Cloak realm router disposed')
    this.disposalPromise = this.disposeConnection()
    return this.disposalPromise
  }

  private async disposeConnection(): Promise<void> {
    try {
      if (this.closed || this.socket.readyState !== 1) return
      const cleanup: Promise<unknown>[] = []
      for (const target of this.sessions.values()) {
        cleanup.push(this.resumeTarget(target))
        if (target.scriptIdentifier !== null) {
          cleanup.push(this.sendCommand('Page.removeScriptToEvaluateOnNewDocument', {
            identifier: target.scriptIdentifier
          }, target.sessionId, true))
        }
        for (const name of target.bindingNames) {
          cleanup.push(this.sendCommand('Runtime.removeBinding', { name }, target.sessionId, true))
        }
      }
      for (const result of await Promise.allSettled(cleanup)) {
        if (result.status === 'rejected' && !this.closed) this.reportFailure(`Realm cleanup failed: ${describeError(result.reason)}`)
      }
      const rootCleanup = await Promise.allSettled([
        // Disable interception first: any response still paused here would
        // stall the page until Chromium tore the connection down.
        this.sendCommand('Fetch.disable', {}, undefined, true),
        this.sendCommand('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, undefined, true),
        this.sendCommand('Target.setDiscoverTargets', { discover: false }, undefined, true)
      ])
      for (const result of rootCleanup) {
        if (result.status === 'rejected' && !this.closed) this.reportFailure(`Root CDP cleanup failed: ${describeError(result.reason)}`)
      }
    } finally {
      this.finishClose()
    }
  }
}
