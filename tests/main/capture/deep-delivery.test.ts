import { createContext, runInContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDeepBootstrap } from '../../../src/main/capture/deep-bootstrap'
import { CAPTURE_BRIDGE_NAME, CAPTURE_MAX_PUSH_CHARS } from '../../../src/shared/capture-protocol'
import { validateBatch } from '../../../src/main/db/capture-reliability-repo'
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

describe('gap diagnostics say what they know', () => {
  function makeController(acceptBatch: unknown = vi.fn(() => { throw new Error('SQLITE_BUSY') })) {
    const repository = {
      beginRun: vi.fn(), endRun: vi.fn(), saveHealth: vi.fn(), getHealth: () => ({ gaps: [] }), acceptBatch,
    } as unknown as CaptureReliabilityRepo
    const context = { sessionId: 'session-1', isClosed: () => false, targets: async () => [], getNativeHandle: () => ({
      addInitScript: async () => ({ dispose: vi.fn() }),
    }) } as unknown as BrowserContext
    return new DeepCaptureController(context, repository, vi.fn(), vi.fn(), { hook: '', interaction: '' })
  }

  it('classifies a router failure without storing its URLs or target ids', async () => {
    const controller = makeController()
    await controller.start('isolated-profile')

    // router 的原文里有 targetId 和 URL——面板承诺不含这些
    routing.options!.onFailure(
      'Worker entry script was not rewritten for TARGET-ABC (https://secret.example.com/app/worker.js); '
      + 'its first statements ran without instrumentation'
    )

    const gap = controller.getHealth().gaps.find(entry => entry.reason === 'worker-entry-script-unrewritten')!
    expect(gap.detail).toBe('worker-entry-script-rewrite-failed')
    const serialized = JSON.stringify(gap)
    expect(serialized).not.toContain('secret.example.com')
    expect(serialized).not.toContain('TARGET-ABC')
    await controller.stop()
  })

  it('counts the events stuck in the queue instead of calling the loss unknown', async () => {
    vi.useFakeTimers()
    // 提交成功但一条都没确认：队列清不掉，pendingEvents 会被真实填上
    const acceptBatch = vi.fn((_session: string, runId: string, _realm: unknown, batch: CaptureBatch): CaptureIngestionResult => ({
      receipt: { runId, producerId: batch.producerId, acknowledged: [], disposition: 'committed' },
      records: [],
    }))
    const controller = makeController(acceptBatch)
    await controller.start('isolated-profile')
    const producer = createProducer(controller.runId)
    producer.bridge.enqueue('hook', { marker: 'stuck' })
    const connection: CaptureRealmConnection = {
      info: { realmId: 'realm-stuck', kind: 'document', targetId: 'target-1', frameId: 'frame-1', tabId: null, earlyInjection: true },
      installBinding: async () => { throw new Error('binding-unavailable') },
      evaluate: async <Value>(expression: string): Promise<Value> => producer.evaluate<Value>(expression),
    }
    routing.options!.onRealm(connection)
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.getHealth().realms[0].pendingEvents).toBeGreaterThan(0)
    const stuck = controller.getHealth().realms[0].pendingEvents

    // 和真实那次一样：realm 先没了，队列里还压着事件，然后才停止会话
    routing.options!.onClosed('realm-stuck')
    await controller.stop()

    const gaps = controller.getHealth().gaps.filter(entry => entry.realmId === 'realm-stuck')
    // 队列长度当场就数得出来，不该记成"覆盖未知 / Dropped events: Unknown"；
    // 而且它是随 realm 一起没的，不是排空超时——两分钟前就销毁的 realm 不该冒充 drain-timeout
    const lost = gaps.find(entry => entry.reason === 'realm-destroyed-with-pending')!
    expect(lost.certainty).toBe('known-loss')
    expect(lost.droppedEvents).toBe(stuck)
    expect(gaps.some(entry => entry.reason === 'drain-timeout')).toBe(false)
  })
})

describe('a 1 MB crypto operation survives the whole delivery chain', () => {
  // 1 MB 的 buffer 转 hex 是 2 M 字符；.result 事件把参数再带一遍加上结果
  const oneMegabyteHex = 'ab'.repeat(1024 * 1024)
  const resultEvent = () => ({
    type: 'ar-hook', hookType: 'crypto', functionName: 'crypto.subtle.decrypt.result',
    arguments: JSON.stringify([{ name: 'AES-GCM' }, oneMegabyteHex]), result: JSON.stringify(oneMegabyteHex),
    callStack: null, timestamp: 1,
  })

  it('is accepted by the bridge, fits one batch, and fits the push guard', () => {
    const { bridge } = createProducer('run-1')
    bridge.enqueue('hook', resultEvent())
    const snapshot = bridge.snapshot()
    // 改之前：单事件 64 KB 上限，这里 droppedEvents 会是 1
    expect(snapshot.status.droppedEvents).toBe(0)
    expect(snapshot.events).toHaveLength(2) // probe 控制事件 + 这一条
    // 推送接收端按字符数设限，整批序列化后必须过得去
    expect(JSON.stringify(snapshot).length).toBeLessThan(5 * 1024 * 1024)
  })

  it('always puts the head event into a batch, however large it is', () => {
    const { bridge } = createProducer('run-1')
    bridge.enqueue('hook', resultEvent())
    bridge.enqueue('hook', resultEvent())
    const first = bridge.snapshot()
    // 两条各约 8.4 MB，一批装不下两条——但至少要装一条，否则队头永远发不出去
    expect(first.events.filter(event => event.stream === 'hook')).toHaveLength(1)
  })

  it('says why it dropped an event', () => {
    const { bridge } = createProducer('run-1')
    const status = () => bridge.snapshot().status
    bridge.enqueue('hook', { huge: 'x'.repeat(5 * 1024 * 1024) })
    expect(status().droppedByReason).toMatchObject({ 'event-oversize': 1 })
    bridge.setBackpressure(true)
    bridge.enqueue('hook', { marker: 'blocked' })
    bridge.setBackpressure(false)
    expect(status().droppedByReason).toMatchObject({ 'event-oversize': 1, backpressure: 1 })
    bridge.recordLoss()
    expect(status().droppedByReason).toMatchObject({ 'serialization-failed': 1 })
    expect(status().droppedEvents).toBe(3)
    // 换纪元时一起清零
    bridge.configure('run-2')
    expect(status().droppedEvents).toBe(0)
    expect(status().droppedByReason).toEqual({ 'event-oversize': 0, 'queue-full': 0, backpressure: 0, 'serialization-failed': 0 })
  })

  it('records a separate producer-queue-loss gap per drop reason', async () => {
    vi.useFakeTimers()
    const acceptBatch = vi.fn((_session: string, runId: string, _realm: unknown, batch: CaptureBatch): CaptureIngestionResult => ({
      receipt: { runId, producerId: batch.producerId, acknowledged: batch.events.map(event => event.sequence), disposition: 'committed' },
      records: [],
    }))
    const repository = {
      beginRun: vi.fn(), endRun: vi.fn(), saveHealth: vi.fn(), getHealth: () => ({ gaps: [] }), acceptBatch,
    } as unknown as CaptureReliabilityRepo
    const context = { sessionId: 'session-1', isClosed: () => false, targets: async () => [], getNativeHandle: () => ({
      addInitScript: async () => ({ dispose: vi.fn() }),
    }) } as unknown as BrowserContext
    const controller = new DeepCaptureController(context, repository, vi.fn(), vi.fn(), { hook: '', interaction: '' })
    await controller.start('isolated-profile')
    const producer = createProducer(controller.runId)
    producer.bridge.enqueue('hook', { huge: 'x'.repeat(5 * 1024 * 1024) })
    producer.bridge.recordLoss()
    producer.bridge.enqueue('hook', { marker: 'fine' })
    const connection: CaptureRealmConnection = {
      info: { realmId: 'realm-1', kind: 'worker', targetId: 'target-1', frameId: null, tabId: null, earlyInjection: true },
      installBinding: async () => { throw new Error('binding-unavailable') },
      evaluate: async <Value>(expression: string): Promise<Value> => producer.evaluate<Value>(expression),
    }
    routing.options!.onRealm(connection)
    await vi.advanceTimersByTimeAsync(0)

    const gaps = controller.getHealth().gaps.filter(gap => gap.reason === 'producer-queue-loss')
    // 改之前是一条 detail 为空的缺口，两种原因合在一个数里
    expect(gaps.map(gap => [gap.detail, gap.droppedEvents]).sort()).toEqual([
      ['event-oversize', 1],
      ['serialization-failed', 1],
    ])
    expect(controller.getHealth().realms[0].droppedByReason).toMatchObject({ 'event-oversize': 1, 'serialization-failed': 1 })
    await controller.stop()
  })

  it('lets a multi-megabyte push through and still refuses a runaway one', async () => {
    const acceptBatch = vi.fn((_session: string, runId: string, _realm: unknown, batch: CaptureBatch): CaptureIngestionResult => ({
      receipt: { runId, producerId: batch.producerId, acknowledged: batch.events.map(event => event.sequence), disposition: 'committed' },
      records: [],
    }))
    const repository = {
      beginRun: vi.fn(), endRun: vi.fn(), saveHealth: vi.fn(), getHealth: () => ({ gaps: [] }), acceptBatch,
    } as unknown as CaptureReliabilityRepo
    const context = { sessionId: 'session-1', isClosed: () => false, targets: async () => [], getNativeHandle: () => ({
      addInitScript: async () => ({ dispose: vi.fn() }),
    }) } as unknown as BrowserContext
    const controller = new DeepCaptureController(context, repository, vi.fn(), vi.fn(), { hook: '', interaction: '' })
    await controller.start('isolated-profile')
    let push: ((payload: string) => void) | null = null
    const connection: CaptureRealmConnection = {
      info: { realmId: 'realm-1', kind: 'worker', targetId: 'target-1', frameId: null, tabId: null, earlyInjection: true },
      installBinding: async (_name: string, callback: (payload: string) => void) => { push = callback },
      evaluate: async <Value>(): Promise<Value> => undefined as Value,
    }
    routing.options!.onRealm(connection)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(push).not.toBeNull()

    const batch = (chars: number): string => JSON.stringify({
      protocolVersion: 1, runId: controller.runId, producerId: 'p',
      events: [{ stream: 'hook', sequence: 1, timestamp: 1, payload: { big: 'x'.repeat(chars) } }],
      status: { installed: {}, pendingEvents: 1, pendingBytes: chars * 2, generatedSequence: 1, droppedEvents: 0, droppedThroughSequence: 0, recording: true },
    })
    push!(batch(4 * 1024 * 1024))
    await new Promise(resolve => setTimeout(resolve, 0))
    // 改之前接收端 512 K 字符就整批扔掉
    expect(acceptBatch).toHaveBeenCalledTimes(1)
    push!(batch(6 * 1024 * 1024))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(acceptBatch).toHaveBeenCalledTimes(1)
    await controller.stop()
  })
})

describe('every layer agrees on how big an event may be', () => {
  const realmInfo = { realmId: 'realm-1', kind: 'worker' as const, targetId: 't', frameId: null, tabId: null, earlyInjection: true }
  const oneMegabyteHex = 'ab'.repeat(1024 * 1024)
  const resultEvent = () => ({
    type: 'ar-hook', hookType: 'crypto', functionName: 'crypto.subtle.decrypt.result',
    arguments: JSON.stringify([{ name: 'AES-GCM' }, oneMegabyteHex]), result: JSON.stringify(oneMegabyteHex),
    callStack: null, timestamp: 1,
  })

  it('a batch the bridge emits is accepted by the repository validator', () => {
    // 3.6.73 只开了 bridge 和推送那三道，仓储的 256 KB / 2 MB 没动：bridge 放过的批次到仓储被整批判 invalid，
    // producer 原样重发、永远进不了库。真实会话里两个 realm 各卡死一批，面板上却是"传送延迟 / Dropped: 0"。
    const { bridge } = createProducer('run-1')
    bridge.enqueue('hook', resultEvent())
    // 生产环境里批次总是经过 JSON 字符串到达仓储（推送是 binding 的字符串，轮询是 evaluate 的返回值）；
    // 直接拿 vm 沙箱里的活对象过校验会因为原型不同被拒，那不是这里要测的
    const batch = JSON.parse(JSON.stringify(bridge.snapshot())) as CaptureBatch
    expect(batch.status.droppedEvents).toBe(0)
    expect(() => validateBatch(batch, 'run-1', realmInfo)).not.toThrow()
    // 推送接收那一道也要过得去
    expect(JSON.stringify(batch).length).toBeLessThan(CAPTURE_MAX_PUSH_CHARS)
  })

  it('the repository still refuses what the bridge would have refused', () => {
    const { bridge } = createProducer('run-1')
    const batch = JSON.parse(JSON.stringify(bridge.snapshot())) as CaptureBatch
    expect(() => validateBatch(batch, 'run-1', realmInfo)).not.toThrow()
    batch.events.push({ stream: 'hook', sequence: 99, timestamp: 1, payload: { ...resultEvent(), result: 'x'.repeat(12 * 1024 * 1024) } })
    batch.status.generatedSequence = 99
    expect(() => validateBatch(batch, 'run-1', realmInfo)).toThrow()
  })
})

describe('a batch the repository rejects is a loss, not a delay', () => {
  function makeController(acceptBatch: unknown) {
    const repository = {
      beginRun: vi.fn(), endRun: vi.fn(), saveHealth: vi.fn(), getHealth: () => ({ gaps: [] }), acceptBatch,
    } as unknown as CaptureReliabilityRepo
    const context = { sessionId: 'session-1', isClosed: () => false, targets: async () => [], getNativeHandle: () => ({
      addInitScript: async () => ({ dispose: vi.fn() }),
    }) } as unknown as BrowserContext
    return new DeepCaptureController(context, repository, vi.fn(), vi.fn(), { hook: '', interaction: '' })
  }

  it('counts the rejected events once, keeps the stuck queue visible, and counts new ones later', async () => {
    vi.useFakeTimers()
    const acceptBatch = vi.fn((_session: string, runId: string, _realm: unknown, batch: CaptureBatch): CaptureIngestionResult => ({
      receipt: { runId, producerId: batch.producerId, acknowledged: [], disposition: 'invalid' },
      records: [],
    }))
    const controller = makeController(acceptBatch)
    await controller.start('isolated-profile')
    const producer = createProducer(controller.runId)
    producer.bridge.enqueue('hook', { marker: 'a' })
    producer.bridge.enqueue('hook', { marker: 'b' })
    const connection: CaptureRealmConnection = {
      info: { realmId: 'realm-1', kind: 'document', targetId: 'target-1', frameId: 'frame-1', tabId: null, earlyInjection: true },
      installBinding: async () => { throw new Error('binding-unavailable') },
      evaluate: async <Value>(expression: string): Promise<Value> => producer.evaluate<Value>(expression),
    }
    routing.options!.onRealm(connection)
    // attach 自己还会入几条，和首轮轮询的先后不定；先让它稳下来再看
    await vi.advanceTimersByTimeAsync(1500)

    const gap = () => controller.getHealth().gaps.find(entry => entry.reason === 'ingestion-invalid')!
    // 改之前：certainty 是 delivery-delay，droppedEvents 为 null，pendingEvents 停在 0
    expect(gap().certainty).toBe('known-loss')
    const settled = gap().droppedEvents!
    // 被拒的批次没有回执，数据事件全留在队列里：计数就是队列里 hook 的条数（control 是协议心跳，
    // 每次轮询都会再入一条，不算丢失）；面板上的 pending 则如实报队列长度
    const queue = producer.bridge.snapshot()
    expect(settled).toBe(queue.events.filter(event => event.stream === 'hook').length)
    // 改之前 pendingEvents 停在上次成功后的 0，队列明明卡着一整批；controller 每次轮询还会再入一条
    // control，所以这里只断言"至少包含卡住的数据事件"，不和此刻的队列长度硬对
    expect(controller.getHealth().realms[0].pendingEvents).toBeGreaterThanOrEqual(settled)

    // producer 每次轮询都会把同一批再发一遍：不能重复计
    await vi.advanceTimersByTimeAsync(750)
    await vi.advanceTimersByTimeAsync(750)
    expect(gap().droppedEvents).toBe(settled)

    // 新进来的才算新的丢失
    producer.bridge.enqueue('hook', { marker: 'c' })
    await vi.advanceTimersByTimeAsync(750)
    expect(gap().droppedEvents).toBe(settled + 1)
    // 排空循环在假时钟下会对活着的 realm 空转（既有行为，见 3.6.72 说明）；先关掉它
    routing.options!.onClosed('realm-1')
    await controller.stop()
  })
})
