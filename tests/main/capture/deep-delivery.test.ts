import { createContext, runInContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDeepBootstrap } from '../../../src/main/capture/deep-bootstrap'
import { CAPTURE_BRIDGE_NAME } from '../../../src/shared/capture-protocol'
import type { CaptureBatch, CaptureBatchReceipt, CaptureIngestionResult } from '../../../src/shared/capture-protocol'
import type { CaptureRealmConnection, CloakRealmRouterOptions } from '../../../src/main/browser/cloak-realm-router'
import type { BrowserContext } from '../../../src/main/browser/contracts'
import type { CaptureReliabilityRepo } from '../../../src/main/db/capture-reliability-repo'

const routing = vi.hoisted(() => ({ options: null as CloakRealmRouterOptions | null, dispose: vi.fn() }))
vi.mock('../../../src/main/browser/cloak-realm-router', () => ({
  CloakRealmRouter: { connect: async (_directory: string, options: CloakRealmRouterOptions) => {
    routing.options = options
    return { dispose: routing.dispose }
  } },
}))
import { DeepCaptureController } from '../../../src/main/capture/deep-capture-controller'

interface TestBridge {
  enqueue(stream: string, payload: Record<string, unknown>): void
  snapshot(): CaptureBatch
  acknowledge(receipt: CaptureBatchReceipt): void
  configure(runId: string): void
  stop(): void
}

function createProducer(runId: string): { bridge: TestBridge; evaluate: <Value>(expression: string) => Promise<Value> } {
  const sandbox = createContext({ crypto: { randomUUID: () => 'producer-1' } })
  runInContext(buildDeepBootstrap(runId, { hook: '', interaction: '' }), sandbox)
  const bridge = sandbox[CAPTURE_BRIDGE_NAME] as TestBridge
  return { bridge, evaluate: async <Value>(expression: string) => runInContext(expression, sandbox) as Value }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); routing.options = null; routing.dispose.mockReset() })

describe('reliable producer queue', () => {
  it('does not mistake an inapplicable Worker hook for an overwritten function', async () => {
    const producer = createProducer('run-1')
    await producer.evaluate(`globalThis.__aaReliableCapture.registerHook('document.cookie.set', () => false, false)`)
    expect(producer.bridge.snapshot().status.installed['document.cookie.set']).toBe('not-applicable')
    expect(producer.bridge.snapshot().status.installed['document.cookie.set']).toBe('not-applicable')
  })

  it('retains data until the matching committed receipt, and preserves holes', () => {
    const { bridge } = createProducer('run-1')
    bridge.enqueue('hook', { marker: 'first' })
    bridge.enqueue('hook', { marker: 'second' })
    const receipt: CaptureBatchReceipt = { runId: 'run-1', producerId: 'producer-1', acknowledged: [1, 3], disposition: 'committed' }
    bridge.acknowledge({ ...receipt, runId: 'old-run' })
    bridge.acknowledge({ ...receipt, disposition: 'retry' })
    expect(bridge.snapshot().events).toHaveLength(3)
    bridge.acknowledge(receipt)
    expect(bridge.snapshot().events.map(event => event.sequence)).toEqual([2])
  })

  it('bounds memory, reports loss, and prevents post-stop relabeling', () => {
    const { bridge } = createProducer('run-1')
    for (let index = 0; index < 5000; index += 1) bridge.enqueue('hook', { marker: index })
    const full = bridge.snapshot()
    expect(full.status.pendingEvents).toBeLessThanOrEqual(4096)
    expect(full.status.pendingBytes).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(full.status.droppedEvents).toBeGreaterThan(0)
    expect(full.events.length).toBeLessThanOrEqual(128)
    bridge.stop()
    bridge.enqueue('hook', { marker: 'after-stop' })
    expect(bridge.snapshot().status.generatedSequence).toBe(full.status.generatedSequence)
    bridge.configure('run-2')
    expect(bridge.snapshot().events).toHaveLength(1)
    expect(bridge.snapshot().events[0].stream).toBe('control')
    bridge.acknowledge({ runId: 'run-1', producerId: 'producer-1', acknowledged: [1], disposition: 'committed' })
    expect(bridge.snapshot().events).toHaveLength(1)
  })
})

describe('Deep controller commit and fallback', () => {
  it('does not ACK a failed commit, recovers by polling, and does not duplicate committed records', async () => {
    vi.useFakeTimers()
    const committedSequences = new Set<number>()
    let failCommit = true
    const acceptBatch = vi.fn((_session: string, runId: string, _realm: unknown, batch: CaptureBatch): CaptureIngestionResult => {
      if (failCommit) throw new Error('SQLITE_BUSY')
      const records = batch.events.filter(event => event.stream === 'hook' && !committedSequences.has(event.sequence))
        .map(event => ({ stream: event.stream, record: { session_id: 'session-1', id: event.sequence } }))
      for (const event of batch.events) committedSequences.add(event.sequence)
      return { receipt: { runId, producerId: batch.producerId, acknowledged: batch.events.map(event => event.sequence), disposition: 'committed' }, records }
    })
    const repository = {
      beginRun: vi.fn(), endRun: vi.fn(), saveHealth: vi.fn(), getHealth: () => ({ gaps: [] }), acceptBatch,
    } as unknown as CaptureReliabilityRepo
    const disposeScript = vi.fn()
    const context = { sessionId: 'session-1', isClosed: () => false, targets: async () => [], getNativeHandle: () => ({
      addInitScript: async () => ({ dispose: disposeScript }),
    }) } as unknown as BrowserContext
    const onRecord = vi.fn()
    const controller = new DeepCaptureController(context, repository, onRecord, vi.fn(), { hook: '', interaction: '' })
    await controller.start('isolated-profile')
    const producer = createProducer(controller.runId)
    producer.bridge.enqueue('hook', { marker: 'event' })
    let failAck = false
    const connection: CaptureRealmConnection = {
      info: { realmId: 'realm-1', kind: 'document', targetId: 'target-1', frameId: 'frame-1', tabId: null, earlyInjection: true },
      installBinding: async () => { throw new Error('binding-unavailable') },
      evaluate: async <Value>(expression: string): Promise<Value> => {
        if (failAck && expression.includes('.acknowledge(')) throw new Error('ack-lost')
        return producer.evaluate<Value>(expression)
      },
    }
    routing.options!.onRealm(connection)
    await vi.advanceTimersByTimeAsync(0)
    expect(producer.bridge.snapshot().events).toHaveLength(3)
    expect(onRecord).not.toHaveBeenCalled()
    expect(controller.getHealth().state).toBe('degraded')
    failCommit = false
    failAck = true
    await vi.advanceTimersByTimeAsync(750)
    expect(onRecord).toHaveBeenCalledTimes(1)
    expect(producer.bridge.snapshot().events.filter(event => event.stream === 'hook')).toHaveLength(1)
    failAck = false
    await vi.advanceTimersByTimeAsync(750)
    expect(onRecord).toHaveBeenCalledTimes(1)
    expect(producer.bridge.snapshot().events).toHaveLength(0)
    expect(controller.getHealth().realms[0].transport).toBe('poll')
    await controller.stop()
    expect(routing.dispose).toHaveBeenCalledOnce()
    expect(disposeScript).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
