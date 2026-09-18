import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CAPTURE_BRIDGE_NAME, CAPTURE_PUSH_BINDING, CAPTURE_WORKER_PATCH_FLAG } from '@shared/capture-protocol'
import type { CaptureBatch, CaptureBatchReceipt, CaptureEnvelope, CaptureProducerStatus, CaptureStream } from '@shared/capture-protocol'

/** This function is serialized into the page. Keep every runtime dependency inside it. */
function installCaptureProducer(runId: string, bridgeName: string, pushBinding: string): void {
  type ProducerBridge = {
    readonly recording: boolean
    readonly runId: string
    configure: (nextRunId: string) => void
    enqueue: (stream: CaptureStream, payload: Record<string, unknown>) => void
    snapshot: () => CaptureBatch
    acknowledge: (receipt: CaptureBatchReceipt) => void
    registerHook: (name: string, verify?: () => boolean, applicable?: boolean) => void
    registerRepair: (name: string, repair: () => void) => void
    repairHooks: () => void
    recordLoss: () => void
    registerFlush: (flush: () => void) => void
    stop: () => void
    push: () => void
    setBackpressure: (enabled: boolean) => void
  }
  const globals = globalThis as unknown as Record<string, unknown>
  const existing = globals[bridgeName] as ProducerBridge | undefined
  if (existing) {
    existing.configure(runId)
    return
  }
  const serialize = JSON.stringify.bind(JSON)
  const deserialize = JSON.parse.bind(JSON)
  const now = Date.now.bind(Date)
  const randomIdentifier = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)
  const producerId = randomIdentifier?.() ?? `${now()}-${Math.random().toString(36).slice(2)}`
  const maximumEvents = 4096
  const maximumBytes = 2 * 1024 * 1024
  const maximumEventBytes = 64 * 1024
  const maximumBatchBytes = 128 * 1024
  const queued: Array<{ event: CaptureEnvelope; bytes: number }> = []
  const verifiers = new Map<string, (() => boolean) | null>()
  const repairs = new Map<string, () => void>()
  const installed: CaptureProducerStatus['installed'] = {}
  const installedAtBootstrap: CaptureProducerStatus['installedAtBootstrap'] = {}
  const flushCallbacks: Array<() => void> = []
  let currentRunId = runId
  let recording = Boolean(runId)
  let generatedSequence = 0
  let pendingBytes = 0
  let droppedEvents = 0
  let droppedThroughSequence = 0
  let pushScheduled = false
  let backpressure = false

  function snapshot(): CaptureBatch {
    for (const [name, verify] of verifiers) {
      if (!verify || installed[name] === 'not-applicable') continue
      try { installed[name] = verify() ? 'installed' : 'overwritten' }
      catch { installed[name] = 'failed' }
    }
    let batchBytes = 0
    const events: CaptureEnvelope[] = []
    for (const entry of queued) {
      if (events.length >= 128 || batchBytes + entry.bytes > maximumBatchBytes) break
      events.push(entry.event)
      batchBytes += entry.bytes
    }
    return {
      protocolVersion: 1,
      runId: currentRunId,
      producerId,
      events,
      status: { installed: { ...installed }, installedAtBootstrap: { ...installedAtBootstrap },
        pendingEvents: queued.length, pendingBytes,
        generatedSequence, droppedEvents, droppedThroughSequence, recording },
    }
  }

  function push(): void {
    const binding = globals[pushBinding]
    if (typeof binding !== 'function' || !currentRunId || queued.length === 0) return
    try { binding(serialize(snapshot())) } catch { /* The host can still poll this queue. */ }
  }

  function schedulePush(): void {
    if (pushScheduled) return
    pushScheduled = true
    Promise.resolve().then(() => { pushScheduled = false; push() })
  }

  function enqueue(stream: CaptureStream, payload: Record<string, unknown>): void {
    if (!recording) return
    generatedSequence += 1
    try {
      const encoded = serialize(payload)
      // Bound by UTF-16 storage size, a conservative budget for the JS heap.
      const bytes = encoded.length * 2 + 128
      const eventLimit = stream === 'control' ? maximumEvents : maximumEvents - 16
      const byteLimit = stream === 'control' ? maximumBytes : maximumBytes - 8192
      if (bytes > maximumEventBytes || queued.length >= eventLimit || pendingBytes + bytes > byteLimit || (backpressure && stream !== 'control')) {
        droppedEvents += 1
        droppedThroughSequence = generatedSequence
        return
      }
      const event = { stream, sequence: generatedSequence, timestamp: now(), payload: deserialize(encoded) }
      queued.push({ event, bytes })
      pendingBytes += bytes
      schedulePush()
    } catch {
      droppedEvents += 1
      droppedThroughSequence = generatedSequence
    }
  }

  const bridge: ProducerBridge = {
    get recording() { return recording },
    get runId() { return currentRunId },
    configure(nextRunId) {
      if (nextRunId === currentRunId) return
      // Host seals the previous epoch before configuration changes. Never relabel old events.
      queued.length = 0
      pendingBytes = 0
      generatedSequence = 0
      droppedEvents = 0
      droppedThroughSequence = 0
      backpressure = false
      currentRunId = nextRunId
      recording = Boolean(nextRunId)
      if (recording) enqueue('control', { kind: 'probe' })
    },
    enqueue,
    snapshot,
    acknowledge(receipt) {
      if (receipt.disposition !== 'committed' || receipt.runId !== currentRunId || receipt.producerId !== producerId) return
      const acknowledged = new Set(receipt.acknowledged)
      for (let index = queued.length - 1; index >= 0; index -= 1) {
        if (acknowledged.has(queued[index].event.sequence)) {
          pendingBytes -= queued[index].bytes
          queued.splice(index, 1)
        }
      }
      if (queued.length) schedulePush()
    },
    registerHook(name, verify, applicable = true) {
      verifiers.set(name, verify ?? null)
      if (!applicable) installed[name] = 'not-applicable'
      else {
        try { installed[name] = !verify || verify() ? 'installed' : 'failed' }
        catch { installed[name] = 'failed' }
      }
      // Repairs re-enter here, so only the first verdict describes what was in
      // place before this realm started running its own code.
      if (!(name in installedAtBootstrap)) installedAtBootstrap[name] = installed[name]
    },
    registerFlush(flush) { flushCallbacks.push(flush) },
    registerRepair(name, repair) { repairs.set(name, repair) },
    recordLoss() {
      if (!recording) return
      generatedSequence += 1
      droppedEvents += 1
      droppedThroughSequence = generatedSequence
    },
    repairHooks() {
      for (const [name, repair] of repairs) {
        const verify = verifiers.get(name)
        try { if (!verify?.()) repair() } catch { installed[name] = 'failed' }
      }
    },
    stop() {
      for (const flush of flushCallbacks) {
        try { flush() } catch { /* One component cannot block the other flushes. */ }
      }
      recording = false
      push()
    },
    push,
    setBackpressure(enabled) { backpressure = enabled },
  }
  Object.defineProperty(globals, bridgeName, { value: bridge, configurable: false, enumerable: false, writable: false })
  if (recording) enqueue('control', { kind: 'probe' })
  if (typeof document !== 'undefined') {
    globalThis.addEventListener('pagehide', () => bridge.stop())
    globalThis.addEventListener('pageshow', (event) => {
      if ((event as PageTransitionEvent).persisted && currentRunId) {
        recording = true
        enqueue('control', { kind: 'bfcache-restored' })
      }
    })
  }
}

/**
 * Serialized into documents only.
 *
 * The router covers a worker's first statement by rewriting the entry script
 * as it comes off the network. A `blob:` or `data:` worker never makes that
 * request, so there is nothing to rewrite — the wrapping has to happen where
 * the URL is handed to the constructor. Reading the source synchronously is
 * what keeps this correct: `new Worker(url)` is synchronous, so an async read
 * would hand the worker its original, uninstrumented source.
 */
function installWorkerSourcePatch(bootstrapSource: string, flagName: string): boolean {
  const globals = globalThis as unknown as Record<string, unknown>
  if (globals[flagName] === true) return true
  const readSource = (url: string): string | null => {
    try {
      const request = new XMLHttpRequest()
      request.open('GET', url, false)
      request.send()
      return typeof request.responseText === 'string' ? request.responseText : null
    } catch { return null }
  }
  const wrapSpecifier = (specifier: unknown): unknown => {
    const url = typeof specifier === 'string' ? specifier
      : specifier instanceof URL ? specifier.href : null
    if (url === null || !/^(?:blob|data):/i.test(url)) return specifier
    const source = readSource(url)
    if (source === null) return specifier
    try {
      return URL.createObjectURL(new Blob([`${bootstrapSource}\n;${source}`], { type: 'text/javascript' }))
    } catch { return specifier }
  }
  let patched = false
  for (const name of ['Worker', 'SharedWorker']) {
    const native = globals[name]
    if (typeof native !== 'function') continue
    // A Proxy keeps Function.prototype.toString native and leaves prototype,
    // name and instanceof untouched, so the patch is not a fingerprint tell.
    globals[name] = new Proxy(native as new (...args: unknown[]) => unknown, {
      construct(target, args, newTarget) {
        const [specifier, ...rest] = args
        return Reflect.construct(target, [wrapSpecifier(specifier), ...rest], newTarget)
      }
    })
    patched = true
  }
  if (patched) {
    Object.defineProperty(globals, flagName, {
      value: true, configurable: false, enumerable: false, writable: false
    })
  }
  return patched
}

const BRIDGE = JSON.stringify(CAPTURE_BRIDGE_NAME)

/**
 * `workerSource`, when given, is the bootstrap this document prepends to the
 * source of any `blob:`/`data:` worker it creates. It is built without a
 * worker patch of its own, so the two variants cannot reference each other.
 */
function buildBootstrapVariant(
  runId: string, hookSource: string, interactionSource: string | null, workerSource: string | null
): string {
  return `(() => {
    const installed = Boolean(globalThis[${BRIDGE}]);
    (${installCaptureProducer.toString()})(${JSON.stringify(runId)}, ${BRIDGE}, ${JSON.stringify(CAPTURE_PUSH_BINDING)});
    if (installed) { globalThis[${BRIDGE}].repairHooks(); return; }
    try { ${hookSource} } catch { globalThis[${BRIDGE}].registerHook('hook-bootstrap', () => false); }
    if (typeof document !== 'undefined') {${interactionSource === null ? '' : `
      try { ${interactionSource} } catch { globalThis[${BRIDGE}].registerHook('interaction-bootstrap', () => false); }`}${workerSource === null ? '' : `
      try {
        const patched = (${installWorkerSourcePatch.toString()})(${JSON.stringify(workerSource)}, ${JSON.stringify(CAPTURE_WORKER_PATCH_FLAG)});
        globalThis[${BRIDGE}].registerHook('worker-source-patch',
          () => globalThis[${JSON.stringify(CAPTURE_WORKER_PATCH_FLAG)}] === true, patched);
      } catch { globalThis[${BRIDGE}].registerHook('worker-source-patch', () => false); }`}
    }
  })();`
}

export function buildDeepBootstrap(runId: string, scripts?: { hook: string; interaction: string }): string {
  const hookSource = scripts?.hook ?? readFileSync(join(__dirname, '../preload/hook-script.js'), 'utf8')
  const interactionSource = scripts?.interaction ?? readFileSync(join(__dirname, '../preload/interaction-hook.js'), 'utf8')
  const workerSource = buildBootstrapVariant(runId, hookSource, null, null)
  return buildBootstrapVariant(runId, hookSource, interactionSource, workerSource)
}
