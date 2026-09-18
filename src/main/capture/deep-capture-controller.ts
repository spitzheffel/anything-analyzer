import { randomUUID } from 'node:crypto'
import type { BrowserContext as PlaywrightContext, Disposable, Frame } from 'playwright-core'
import type { BrowserContext } from '../browser/contracts'
import type { CaptureRealmConnection, CloakRealmRouter } from '../browser/cloak-realm-router'
import type { CaptureReliabilityRepo } from '../db/capture-reliability-repo'
import { CAPTURE_BRIDGE_NAME, CAPTURE_PUSH_BINDING } from '@shared/capture-protocol'
import type { CaptureAcceptedRecord, CaptureBatch, CaptureGap, CaptureHealthSnapshot, CaptureRealmHealth } from '@shared/capture-protocol'
import { buildDeepBootstrap } from './deep-bootstrap'
import { withCaptureDeadline } from './capture-deadline'

const POLL_INTERVAL_MS = 750
const MAXIMUM_REALMS = 128
const MAXIMUM_CONTEXT_PENDING_BYTES = 32 * 1024 * 1024
const DRAIN_TIMEOUT_MS = 5000
const bridgeExpression = `globalThis[${JSON.stringify(CAPTURE_BRIDGE_NAME)}]`

interface RealmState {
  connection: CaptureRealmConnection
  health: CaptureRealmHealth
  processing: Promise<void> | null
  closed: boolean
  producerStopped: boolean
  recoveryUntil: number
  pendingPush: CaptureBatch | null
}

/** Owns one immutable capture epoch. Neither callbacks nor receipts outlive it. */
export class DeepCaptureController {
  readonly runId = randomUUID()
  private readonly realms = new Map<string, RealmState>()
  private readonly fallbackFrames = new WeakMap<Frame, RealmState>()
  private router: CloakRealmRouter | null = null
  private initScript: Disposable | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private accepting = true
  private draining = false
  private source = ''
  private stopping: Promise<void> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnecting = false
  private reconnectAttempts = 0
  private profileDirectory: string | null = null
  private expectedTargetId: string | undefined
  private snapshot: CaptureHealthSnapshot

  constructor(
    private readonly context: BrowserContext,
    private readonly repository: CaptureReliabilityRepo,
    private readonly onRecord: (record: CaptureAcceptedRecord) => void,
    private readonly onHealth: (snapshot: CaptureHealthSnapshot) => void,
    private readonly bootstrapScripts?: { hook: string; interaction: string },
  ) {
    this.snapshot = {
      sessionId: context.sessionId, runId: this.runId, revision: 0, state: 'starting',
      network: 'unknown', workerCoverage: 'unknown', realms: [], gaps: [], persistenceError: null,
    }
  }

  getHealth(): CaptureHealthSnapshot { return structuredClone(this.snapshot) }

  setNetworkState(state: CaptureHealthSnapshot['network']): void {
    this.snapshot.network = state
    this.publish()
  }

  async start(userDataDir: string | null): Promise<void> {
    try {
      this.repository.beginRun(this.context.sessionId, this.runId)
      this.snapshot.gaps = this.repository.getHealth(this.context.sessionId).gaps
      this.source = buildDeepBootstrap(this.runId, this.bootstrapScripts)
      const nativeContext = this.context.getNativeHandle<PlaywrightContext>()
      const installation = nativeContext.addInitScript({ content: this.source })
      void installation.then(script => {
        if (this.accepting) this.initScript = script
        else void script.dispose().catch(() => undefined)
      }, () => undefined)
      this.initScript = await withCaptureDeadline(installation, 2000, 'Deep init-script installation')
      if (!userDataDir) throw new Error('Cloak profile directory is unavailable for worker instrumentation')
      this.profileDirectory = userDataDir
      const [identityTarget] = await this.context.targets()
      let expectedTargetId: string | undefined
      if (identityTarget) {
        const identityLease = await (await identityTarget.getCdpTransport()).acquire('capture:realm-identity')
        try {
          const identity = await withCaptureDeadline(identityLease.send<{ targetInfo: { targetId: string } }>('Target.getTargetInfo'), 2000, 'Cloak browser identity')
          expectedTargetId = identity.targetInfo.targetId
        } finally { await identityLease.release() }
      }
      this.expectedTargetId = expectedTargetId
      const { CloakRealmRouter: RealmRouter } = await import('../browser/cloak-realm-router')
      this.router = await RealmRouter.connect(userDataDir, {
        bootstrapSource: this.source,
        expectedTargetId,
        onRealm: (connection) => { void this.attachRealm(connection) },
        onClosed: (realmId) => this.closeRealm(realmId),
        onFailure: (reason) => {
          if (!this.accepting) return
          console.warn('[DeepCapture] Realm router reported a coverage limitation', { reason })
          if (reason.startsWith('Worker entry script was not rewritten')) {
            // One worker ran its first statements uninstrumented. Everything
            // else — network, documents, other workers — is still covered, so
            // this is a bounded gap, not an unavailable instrumentation layer.
            this.snapshot.workerCoverage = 'late-attachment'
            this.addGap(null, 'worker-entry-script-unrewritten', 'unknown-coverage')
          } else if (reason.startsWith('Late attachment')) {
            if (!reason.includes('document target')) this.snapshot.workerCoverage = 'late-attachment'
            this.addGap(null, 'target-startup-unverified', 'unknown-coverage')
          } else {
            this.snapshot.workerCoverage = 'unavailable'
            this.addGap(null, 'cdp-instrumentation-unavailable', 'unknown-coverage')
          }
          this.publish()
          if (reason.includes('WebSocket')) this.scheduleReconnect()
        },
      })
      // Availability alone is not evidence that a worker's first script was covered.
    } catch (error) {
      this.snapshot.workerCoverage = 'unavailable'
      this.addGap(null, this.source ? 'worker-routing-unavailable' : 'bootstrap-installation-failed', 'unknown-coverage')
      console.warn('[DeepCapture] Instrumentation startup degraded', { sessionId: this.context.sessionId, error })
    }
    this.publish()
    this.schedulePoll()
  }

  private async attachRealm(connection: CaptureRealmConnection): Promise<void> {
    if (this.draining) {
      try { await withCaptureDeadline(connection.evaluate(`${bridgeExpression}?.stop()`), 2000, 'Stop late realm') }
      catch { /* Target may have already disappeared. */ }
      return
    }
    if (!this.accepting) return
    const previous = this.realms.get(connection.info.realmId)
    if (previous && !previous.closed) return
    if ([...this.realms.values()].filter(realm => !realm.closed).length >= MAXIMUM_REALMS) {
      this.addGap(null, 'context-realm-budget-exceeded', 'unknown-coverage')
      try { await withCaptureDeadline(connection.evaluate(`${bridgeExpression}?.stop()`), 2000, 'Stop over-budget realm') }
      catch { /* Only the admitted realms remain under active collection. */ }
      this.publish()
      return
    }
    const state: RealmState = {
      connection: {
        ...connection,
        evaluate: <Value>(expression: string) => withCaptureDeadline(connection.evaluate<Value>(expression), 2000, 'Realm evaluation'),
      }, processing: null, closed: false, producerStopped: false, recoveryUntil: Date.now() + 10000, pendingPush: null,
      health: { ...connection.info, runId: this.runId, producerId: previous?.health.producerId ?? null, state: 'starting',
        transport: 'unavailable', installed: {}, pendingEvents: 0, pendingBytes: 0,
        droppedEvents: previous?.health.droppedEvents ?? 0, lastConfirmedAt: null, reason: null },
    }
    this.realms.set(connection.info.realmId, state)
    if (!connection.info.earlyInjection) {
      this.addGap(connection.info.realmId, 'late-attachment', 'unknown-coverage')
      if (connection.info.kind !== 'document') this.snapshot.workerCoverage = 'late-attachment'
    }
    try {
      await state.connection.evaluate(this.source)
      try {
        await withCaptureDeadline(connection.installBinding(CAPTURE_PUSH_BINDING, (payload) => {
          if (payload.length > 512 * 1024) return
          try { void this.processBatch(state, JSON.parse(payload) as CaptureBatch, 'push') }
          catch { this.markFailure(state, 'invalid-push-payload') }
        }), 2000, 'Realm binding registration')
        state.health.transport = 'push'
        await state.connection.evaluate(`${bridgeExpression}?.push()`)
      } catch {
        state.health.transport = 'poll'
      }
      await this.pollRealm(state)
    } catch {
      this.markFailure(state, 'realm-initialization-failed')
    }
  }

  private processBatch(state: RealmState, batch: CaptureBatch, transport: 'push' | 'poll'): Promise<void> {
    if (!this.accepting || state.closed || batch?.runId !== this.runId) return Promise.resolve()
    // Push and poll race over the same queue. Dedup also survives an ACK loss.
    if (transport === 'push') state.recoveryUntil = Date.now() + 10000
    if (state.processing) {
      if (transport === 'push') state.pendingPush = batch
      return state.processing
    }
    const processing = Promise.resolve().then(async () => {
      if (!this.accepting || state.closed) return
      try {
        const result = this.repository.acceptBatch(this.context.sessionId, this.runId, state.connection.info, batch)
        if (result.receipt.disposition !== 'committed') {
          this.markFailure(state, `ingestion-${result.receipt.disposition}`)
          return
        }
        const previousDropped = state.health.droppedEvents
        state.health.producerId = batch.producerId
        state.health.installed = batch.status.installed
        state.health.pendingEvents = batch.status.pendingEvents
        state.health.pendingBytes = batch.status.pendingBytes
        state.health.droppedEvents = Math.max(previousDropped, batch.status.droppedEvents)
        state.producerStopped = !batch.status.recording
        state.health.transport = transport === 'push' ? 'push' : state.health.transport === 'unavailable' ? 'poll' : state.health.transport
        if (batch.status.droppedEvents > previousDropped) {
          this.addGap(state.health.realmId, 'producer-queue-loss', 'known-loss', batch.status.droppedEvents - previousDropped)
        }
        for (const record of result.records) {
          try { this.onRecord(record) } catch { /* Persistence already committed; never revoke its receipt. */ }
        }
        if (result.receipt.acknowledged.length) state.health.lastConfirmedAt = Date.now()
        const brokenHook = Object.values(batch.status.installed).some(value => value === 'failed' || value === 'overwritten')
        state.health.state = brokenHook ? 'degraded' : state.health.lastConfirmedAt ? 'healthy' : 'starting'
        state.health.reason = brokenHook ? 'hook-verification-failed' : null
        if (state.health.kind !== 'document' && state.health.earlyInjection && state.health.state === 'healthy'
          && this.snapshot.workerCoverage === 'unknown') this.snapshot.workerCoverage = 'verified'
        if (brokenHook) this.addGap(state.health.realmId, 'hook-verification-failed', 'unknown-coverage')
        for (const gap of this.snapshot.gaps) {
          if (gap.realmId === state.health.realmId && gap.endedAt === null && (gap.certainty === 'delivery-delay'
            || (!brokenHook && gap.reason === 'hook-verification-failed'))) gap.endedAt = Date.now()
        }
        this.snapshot.persistenceError = null
        this.publish()
        // The receipt is sent only after transaction commit, and to this incarnation.
        if (!state.closed && this.accepting) {
          try { await state.connection.evaluate(`${bridgeExpression}?.acknowledge(${JSON.stringify(result.receipt)})`) }
          catch { this.markFailure(state, 'ack-delivery-failed'); return }
          state.health.pendingEvents = Math.max(0, batch.status.pendingEvents - result.receipt.acknowledged.length)
          state.health.pendingBytes = state.health.pendingEvents ? batch.status.pendingBytes : 0
        }
      } catch (error) {
        // No receipt on DB failure. Keep producer data for the next poll/push.
        this.snapshot.persistenceError = error instanceof Error ? error.name : 'CapturePersistenceError'
        this.markFailure(state, 'commit-or-ack-failed')
      }
    }).finally(() => {
      if (state.processing === processing) state.processing = null
      const pendingPush = state.pendingPush
      state.pendingPush = null
      if (pendingPush && this.accepting && !state.closed) void this.processBatch(state, pendingPush, 'push')
    })
    state.processing = processing
    return processing
  }

  private async pollRealm(state: RealmState): Promise<void> {
    if (state.closed || !this.accepting) return
    if (state.processing) await state.processing
    try {
      const batch = await state.connection.evaluate<CaptureBatch | null>(`${bridgeExpression}?.snapshot() ?? null`)
      if (!batch) {
        await state.connection.evaluate(this.source)
        this.markFailure(state, 'bootstrap-missing')
        return
      }
      if (Object.values(batch.status.installed).some(value => value === 'failed' || value === 'overwritten')) {
        await state.connection.evaluate(`${bridgeExpression}?.repairHooks()`)
      }
      if (state.health.producerId && batch.producerId !== state.health.producerId && state.health.realmId.startsWith('fallback-')) {
        this.closeRealm(state.health.realmId)
        return
      }
      if (!this.draining && state.health.kind !== 'service_worker' && (!state.health.lastConfirmedAt || Date.now() - state.health.lastConfirmedAt > 5000)) {
        await state.connection.evaluate(`${bridgeExpression}?.enqueue('control', {kind:'health-probe'})`)
      }
      await this.processBatch(state, batch, 'poll')
    } catch {
      if (!state.closed) this.markFailure(state, 'realm-evaluation-unavailable')
    }
  }

  private async discoverFallbackDocuments(): Promise<void> {
    if (this.router || !this.source || this.context.isClosed()) return
    const targets = await this.context.targets()
    for (const target of targets) {
      const page = target.getNativeHandle<import('playwright-core').Page>()
      for (const frame of page.frames()) {
        const existing = this.fallbackFrames.get(frame)
        if (existing && !existing.closed) continue
        const realmId = `fallback-${randomUUID()}`
        const connection: CaptureRealmConnection = {
          info: { realmId, kind: 'document', targetId: target.id, frameId: null, tabId: target.tabId, earlyInjection: false },
          evaluate: <Value>(expression: string) => frame.evaluate(expression) as Promise<Value>,
          installBinding: async () => { throw new Error('Polling-only fallback') },
        }
        await this.attachRealm(connection)
        const attached = this.realms.get(realmId)
        if (attached) this.fallbackFrames.set(frame, attached)
      }
    }
  }

  private schedulePoll(): void {
    if (!this.accepting || this.draining) return
    this.timer = setTimeout(() => {
      void this.poll().finally(() => this.schedulePoll())
    }, POLL_INTERVAL_MS)
  }

  private scheduleReconnect(): void {
    if (!this.accepting || this.draining || this.reconnectTimer || this.reconnecting || !this.profileDirectory) return
    const delay = [1000, 3000, 10000][Math.min(this.reconnectAttempts, 2)]
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnectRouter()
    }, delay)
  }

  private async reconnectRouter(): Promise<void> {
    if (!this.accepting || this.draining || !this.profileDirectory) return
    this.reconnecting = true
    this.reconnectAttempts += 1
    try {
      await this.router?.dispose()
      const { CloakRealmRouter: RealmRouter } = await import('../browser/cloak-realm-router')
      const replacement = await RealmRouter.connect(this.profileDirectory, {
        bootstrapSource: this.source, expectedTargetId: this.expectedTargetId,
        onRealm: connection => { void this.attachRealm(connection) },
        onClosed: realmId => this.closeRealm(realmId),
        onFailure: () => {
          if (!this.accepting) return
          this.snapshot.workerCoverage = 'unavailable'
          this.addGap(null, 'cdp-recovery-incomplete', 'unknown-coverage')
          this.publish()
        },
      })
      if (!this.accepting || this.draining) await replacement.dispose()
      else {
        this.router = replacement
        this.snapshot.workerCoverage = 'late-attachment'
        this.reconnectAttempts = 0
        this.publish()
      }
    } catch { /* Backoff keeps network capture usable while the endpoint recovers. */ }
    finally {
      this.reconnecting = false
      if (!this.router?.capabilities.flatAutoAttach) this.scheduleReconnect()
    }
  }

  private async poll(): Promise<void> {
    if (!this.accepting) return
    try {
      await this.discoverFallbackDocuments()
      const active = [...this.realms.values()].filter(state => !state.closed)
      const pendingBytes = active.reduce((total, state) => total + state.health.pendingBytes, 0)
      if (pendingBytes > MAXIMUM_CONTEXT_PENDING_BYTES) this.addGap(null, 'context-backpressure', 'delivery-delay')
      await Promise.allSettled(active.filter(state => state.health.kind !== 'service_worker')
        .map(state => state.connection.evaluate(`${bridgeExpression}?.setBackpressure(${pendingBytes > MAXIMUM_CONTEXT_PENDING_BYTES})`)))
      await Promise.allSettled(active.filter(state => this.draining || state.health.kind !== 'service_worker'
        || (state.health.pendingEvents > 0 && Date.now() < state.recoveryUntil))
        .map(state => this.pollRealm(state)))
      this.publish()
    } catch { this.publish() }
  }

  private closeRealm(realmId: string): void {
    if (!this.accepting) return
    const state = this.realms.get(realmId)
    if (!state || state.closed) return
    state.closed = true
    // A vanished JS realm cannot prove its final queue was empty, even if the last poll was.
    if (!state.producerStopped || state.health.pendingEvents) this.addGap(realmId, 'realm-destroyed-unverified-tail', 'unknown-coverage')
    state.health.state = 'stopped'
    if (this.realms.size > 256) {
      const oldestClosed = [...this.realms.values()].find(realm => realm.closed && realm !== state)
      if (oldestClosed) this.realms.delete(oldestClosed.health.realmId)
    }
    this.publish()
  }

  private markFailure(state: RealmState, reason: string): void {
    if (!this.accepting || state.closed) return
    state.health.state = 'degraded'
    state.health.reason = reason
    this.addGap(state.health.realmId, reason, 'delivery-delay')
    this.publish()
  }

  private addGap(realmId: string | null, reason: string, certainty: CaptureGap['certainty'], droppedEvents: number | null = null): void {
    const previous = this.snapshot.gaps.find(gap => gap.realmId === realmId && gap.reason === reason && gap.endedAt === null)
    if (previous) {
      if (droppedEvents !== null) previous.droppedEvents = (previous.droppedEvents ?? 0) + droppedEvents
      return
    }
    this.snapshot.gaps.push({ runId: this.runId, realmId, startedAt: Date.now(), endedAt: null, reason, certainty, droppedEvents })
  }

  private publish(): void {
    this.snapshot.realms = [...this.realms.values()].map(state => ({ ...state.health }))
    const live = this.snapshot.realms.filter(realm => realm.state !== 'stopped')
    if (this.accepting) this.snapshot.state = this.snapshot.persistenceError || this.snapshot.workerCoverage === 'unavailable'
      || live.some(realm => realm.state === 'degraded') ? 'degraded'
      : live.length && live.every(realm => realm.state === 'healthy') ? 'healthy' : 'starting'
    this.snapshot.revision += 1
    try { this.repository.saveHealth(this.getHealth()) }
    catch { this.snapshot.persistenceError = 'HealthPersistenceError'; this.snapshot.state = this.accepting ? 'degraded' : 'stopped' }
    try { this.onHealth(this.getHealth()) } catch { /* UI availability is independent of persistence. */ }
  }

  stop(state: 'stopped' | 'paused' = 'stopped'): Promise<void> {
    this.stopping ??= this.stopOnce(state)
    return this.stopping
  }

  private async stopOnce(state: 'stopped' | 'paused'): Promise<void> {
    this.draining = true
    if (this.timer) clearTimeout(this.timer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const deadline = Date.now() + DRAIN_TIMEOUT_MS
    const drain = async (): Promise<void> => {
      await Promise.allSettled([...this.realms.values()].filter(realm => !realm.closed)
        .map(realm => realm.connection.evaluate(`${bridgeExpression}?.stop()`)))
      do {
        await this.poll()
        if ([...this.realms.values()].every(realm => realm.closed || (!realm.health.pendingEvents && !realm.processing))) break
      } while (this.accepting && Date.now() < deadline)
    }
    try { await withCaptureDeadline(drain(), DRAIN_TIMEOUT_MS, 'Deep capture drain') }
    catch { this.addGap(null, 'drain-timeout', 'unknown-coverage') }
    for (const realm of this.realms.values()) {
      if (realm.health.pendingEvents || realm.processing) this.addGap(realm.health.realmId, 'drain-timeout', 'unknown-coverage')
    }
    await Promise.allSettled([...this.realms.values()].filter(realm => !realm.closed)
      .map(realm => realm.connection.evaluate(`${bridgeExpression}?.configure('')`)))
    this.accepting = false
    for (const realm of this.realms.values()) realm.health.state = 'stopped'
    this.snapshot.state = 'stopped'
    this.snapshot.network = 'stopped'
    for (const gap of this.snapshot.gaps) if (gap.endedAt === null) gap.endedAt = Date.now()
    this.publish()
    try { this.repository.endRun(this.runId, state) } catch { /* Health retains a persistence failure indication. */ }
    try { await this.router?.dispose() }
    finally { await this.initScript?.dispose() }
  }
}
