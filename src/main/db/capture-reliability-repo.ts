import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  CAPTURE_PROTOCOL_VERSION,
  type CaptureAcceptedRecord,
  type CaptureBatch,
  type CaptureEnvelope,
  type CaptureGap,
  type CaptureHealthSnapshot,
  type CaptureIngestionResult,
  type CaptureRealmInfo,
} from '../../shared/capture-protocol'

const MAX_BATCH_EVENTS = 256
const MAX_BATCH_BYTES = 2 * 1024 * 1024
const MAX_PAYLOAD_BYTES = 256 * 1024
const HOOK_TYPES = new Set(['fetch', 'xhr', 'crypto', 'crypto_lib', 'cookie_set'])
const INTERACTION_TYPES = new Set(['click', 'dblclick', 'input', 'scroll', 'navigate', 'hover'])
const INSTALLATION_STATES = new Set(['installed', 'failed', 'not-applicable', 'overwritten'])
const REALM_KINDS = new Set(['document', 'worker', 'shared_worker', 'service_worker'])
const INTERACTION_TEXT_FIELDS = [
  'selector', 'xpath', 'tagName', 'elementText', 'inputValue', 'key', 'pageTitle',
] as const
const INTERACTION_NUMBER_FIELDS = [
  'x', 'y', 'viewportX', 'viewportY', 'scrollX', 'scrollY', 'scrollDX', 'scrollDY',
] as const

type RunState = 'active' | 'draining' | 'stopped' | 'paused' | 'interrupted'
interface RealmBinding {
  producerId: string
  realm: CaptureRealmInfo
}
interface CaptureRunRow {
  run_id: string
  session_id: string
  state: RunState
  started_at: number
  ended_at: number | null
  reason: string | null
  realm_bindings_json: string
}

class InvalidCaptureBatch extends Error {}

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new InvalidCaptureBatch('Invalid capture batch')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Canonical JSON makes object key order irrelevant to receipt conflict checks. */
function serializeCanonical(value: unknown, depth = 0, budget = { remaining: 50_000, remainingBytes: MAX_BATCH_BYTES }): string {
  requireValid(depth <= 24 && --budget.remaining >= 0)
  const consumeBytes = (serialized: string): string => {
    budget.remainingBytes -= Buffer.byteLength(serialized, 'utf8')
    requireValid(budget.remainingBytes >= 0)
    return serialized
  }
  if (value === null) return consumeBytes('null')
  if (typeof value === 'string') {
    requireValid(value.length <= MAX_BATCH_BYTES)
    return consumeBytes(JSON.stringify(value))
  }
  if (typeof value === 'boolean') return consumeBytes(JSON.stringify(value))
  if (typeof value === 'number') {
    requireValid(Number.isFinite(value))
    return consumeBytes(JSON.stringify(value))
  }
  if (Array.isArray(value)) {
    requireValid(value.length <= 50_000)
    budget.remainingBytes -= 2 + Math.max(0, value.length - 1)
    requireValid(budget.remainingBytes >= 0)
    return `[${value.map((entry) => serializeCanonical(entry, depth + 1, budget)).join(',')}]`
  }
  requireValid(isObject(value))
  const prototype = Object.getPrototypeOf(value)
  requireValid(prototype === Object.prototype || prototype === null)
  const keys = Object.keys(value).sort()
  requireValid(keys.length <= 512)
  budget.remainingBytes -= 2 + Math.max(0, keys.length - 1)
  requireValid(budget.remainingBytes >= 0)
  return `{${keys.map((key) => {
    requireValid(key.length <= 1024)
    const serializedKey = consumeBytes(`${JSON.stringify(key)}:`)
    return `${serializedKey}${serializeCanonical(value[key], depth + 1, budget)}`
  }).join(',')}}`
}

function validateRealm(realm: CaptureRealmInfo): CaptureRealmInfo {
  requireValid(isObject(realm) && isIdentifier(realm.realmId) && isIdentifier(realm.targetId))
  requireValid(REALM_KINDS.has(realm.kind))
  requireValid(realm.frameId === null || isIdentifier(realm.frameId))
  requireValid(realm.tabId === null || isIdentifier(realm.tabId))
  requireValid(typeof realm.earlyInjection === 'boolean')
  return {
    realmId: realm.realmId,
    kind: realm.kind,
    targetId: realm.targetId,
    frameId: realm.frameId,
    tabId: realm.tabId,
    earlyInjection: realm.earlyInjection,
  }
}

function validatePayload(event: CaptureEnvelope, realm: CaptureRealmInfo): void {
  const payload = event.payload
  requireValid(isObject(payload))
  requireValid(Buffer.byteLength(serializeCanonical(payload), 'utf8') <= MAX_PAYLOAD_BYTES)
  if (event.stream === 'control') return
  requireValid(isCounter(payload.timestamp))
  if (event.stream === 'hook') {
    requireValid(typeof payload.hookType === 'string' && HOOK_TYPES.has(payload.hookType))
    requireValid(typeof payload.functionName === 'string' && payload.functionName.length > 0)
    requireValid(Object.hasOwn(payload, 'arguments'))
    requireValid(payload.callStack == null || typeof payload.callStack === 'string')
    return
  }
  requireValid(event.stream === 'interaction' && realm.kind === 'document')
  requireValid(typeof payload.interactionType === 'string' && INTERACTION_TYPES.has(payload.interactionType))
  requireValid(typeof payload.url === 'string')
  for (const field of INTERACTION_TEXT_FIELDS) {
    requireValid(payload[field] == null || typeof payload[field] === 'string')
  }
  for (const field of INTERACTION_NUMBER_FIELDS) {
    requireValid(payload[field] == null || (typeof payload[field] === 'number' && Number.isFinite(payload[field])))
  }
  if (payload.attributes != null) {
    requireValid(isObject(payload.attributes) && Object.values(payload.attributes).every((value) => typeof value === 'string'))
  }
  if (payload.boundingRect != null) {
    requireValid(isObject(payload.boundingRect))
    for (const field of ['x', 'y', 'width', 'height']) {
      requireValid(typeof payload.boundingRect[field] === 'number' && Number.isFinite(payload.boundingRect[field]))
    }
  }
  if (payload.path != null) {
    requireValid(Array.isArray(payload.path) && payload.path.length <= 4096)
    for (const point of payload.path) {
      requireValid(isObject(point))
      requireValid(typeof point.x === 'number' && Number.isFinite(point.x))
      requireValid(typeof point.y === 'number' && Number.isFinite(point.y))
      requireValid(isCounter(point.t))
    }
  }
}

function validateBatch(batch: CaptureBatch, runId: string, realm: CaptureRealmInfo): void {
  requireValid(isObject(batch) && batch.protocolVersion === CAPTURE_PROTOCOL_VERSION)
  requireValid(batch.runId === runId && isIdentifier(batch.producerId))
  requireValid(Array.isArray(batch.events) && batch.events.length <= MAX_BATCH_EVENTS)
  requireValid(Buffer.byteLength(serializeCanonical(batch), 'utf8') <= MAX_BATCH_BYTES)
  const status = batch.status
  requireValid(isObject(status) && isObject(status.installed))
  // installedAtBootstrap is additive and stays optional: a service worker
  // revived from its script cache still runs the bootstrap that was rewritten
  // into it by an earlier build, and rejecting its batches outright would lose
  // real capture data to report a missing diagnostic field.
  requireValid(status.installedAtBootstrap === undefined || isObject(status.installedAtBootstrap))
  for (const map of [status.installed, status.installedAtBootstrap ?? {}]) {
    requireValid(Object.values(map as object).every((state) => INSTALLATION_STATES.has(String(state))))
  }
  for (const field of ['pendingEvents', 'pendingBytes', 'generatedSequence', 'droppedEvents', 'droppedThroughSequence'] as const) {
    requireValid(isCounter(status[field]))
  }
  requireValid(typeof status.recording === 'boolean')
  requireValid(status.droppedThroughSequence <= status.generatedSequence)
  let previousSequence = 0
  for (const event of batch.events) {
    requireValid(isObject(event) && isCounter(event.sequence) && event.sequence > previousSequence)
    requireValid(event.sequence <= status.generatedSequence && isCounter(event.timestamp))
    requireValid(event.stream === 'hook' || event.stream === 'interaction' || event.stream === 'control')
    validatePayload(event, realm)
    previousSequence = event.sequence
  }
}

function createUnknownHealth(sessionId: string, runId: string | null = null): CaptureHealthSnapshot {
  return {
    sessionId,
    runId,
    revision: 0,
    state: 'unknown',
    network: 'unknown',
    workerCoverage: 'unknown',
    realms: [],
    gaps: [],
    persistenceError: null,
  }
}

function isHealthSnapshot(value: unknown, sessionId: string): value is CaptureHealthSnapshot {
  if (!isObject(value) || value.sessionId !== sessionId) return false
  return (value.runId === null || isIdentifier(value.runId))
    && isCounter(value.revision)
    && ['starting', 'healthy', 'degraded', 'stopped', 'unknown'].includes(String(value.state))
    && ['running', 'stopped', 'unknown'].includes(String(value.network))
    && ['verified', 'late-attachment', 'unavailable', 'unknown'].includes(String(value.workerCoverage))
    && Array.isArray(value.realms)
    && Array.isArray(value.gaps)
    && (value.persistenceError === null || typeof value.persistenceError === 'string')
}

function mergeGaps(previousGaps: CaptureGap[], incomingGaps: CaptureGap[]): CaptureGap[] {
  const merged = new Map<string, CaptureGap>()
  for (const gap of [...previousGaps, ...incomingGaps]) {
    const key = JSON.stringify([gap.runId, gap.realmId, gap.startedAt, gap.reason, gap.certainty])
    const previous = merged.get(key)
    merged.set(key, {
      ...gap,
      endedAt: gap.endedAt ?? previous?.endedAt ?? null,
      droppedEvents: gap.droppedEvents ?? previous?.droppedEvents ?? null,
    })
  }
  return [...merged.values()]
}

/** Receipts and business rows share one durable, backend-scoped commit boundary. */
export class CaptureReliabilityRepo {
  constructor(private readonly db: Database.Database) {
    db.pragma('synchronous = FULL')
  }

  beginRun(sessionId: string, runId: string): void {
    if (!isIdentifier(sessionId) || !isIdentifier(runId)) throw new Error('Invalid capture run identity')
    this.db.transaction(() => {
      const existingRun = this.findRun(runId)
      if (existingRun) {
        if (existingRun.session_id === sessionId && this.isOpen(existingRun)) return
        throw new Error('Capture run identity cannot be reused')
      }
      this.db.prepare(`
        INSERT INTO capture_runs (run_id, session_id, state, started_at)
        VALUES (?, ?, 'active', ?)
      `).run(runId, sessionId, Date.now())
      const previous = this.getHealth(sessionId)
      this.writeHealth({ ...createUnknownHealth(sessionId, runId), state: 'starting', gaps: previous.gaps })
    }).immediate()
  }

  endRun(runId: string, state: 'stopped' | 'paused' | 'interrupted', reason?: string): void {
    if (!['stopped', 'paused', 'interrupted'].includes(state)) throw new Error('Invalid sealed run state')
    this.db.transaction(() => {
      const run = this.findRun(runId)
      if (!run || !this.isOpen(run)) return
      const endedAt = Date.now()
      this.db.prepare('UPDATE capture_runs SET state = ?, ended_at = ?, reason = ? WHERE run_id = ?')
        .run(state, endedAt, reason ?? null, runId)
      const health = this.getHealth(run.session_id)
      if (health.runId !== null && health.runId !== runId) return
      const interruptionReason = reason ?? 'Capture run interrupted before a clean shutdown'
      const interruptionGaps: CaptureGap[] = state === 'interrupted' ? [{
        runId,
        realmId: null,
        startedAt: run.started_at,
        endedAt,
        reason: interruptionReason,
        certainty: 'unknown-coverage',
        droppedEvents: null,
      }] : []
      this.writeHealth({
        ...health,
        runId,
        revision: health.revision + 1,
        state: state === 'interrupted' ? 'degraded' : 'stopped',
        network: 'stopped',
        realms: health.realms.map((realm) => ({
          ...realm,
          state: state === 'interrupted' ? 'degraded' : 'stopped',
          reason: reason ?? realm.reason,
        })),
        gaps: mergeGaps(health.gaps, interruptionGaps),
      })
    }).immediate()
  }

  acceptBatch(sessionId: string, runId: string, realm: CaptureRealmInfo, batch: CaptureBatch): CaptureIngestionResult {
    const createResult = (disposition: CaptureIngestionResult['receipt']['disposition']): CaptureIngestionResult => ({
      receipt: {
        runId,
        producerId: typeof batch?.producerId === 'string' ? batch.producerId : '',
        acknowledged: [],
        disposition,
      },
      records: [],
    })
    try {
      requireValid(isIdentifier(sessionId) && isIdentifier(runId))
      const ownedRealm = validateRealm(realm)
      validateBatch(batch, runId, ownedRealm)
      // A savepoint is not a durable commit and cannot authorize an acknowledgement.
      if (this.db.inTransaction) throw new Error('Capture ingestion requires its own commit boundary')
      return this.db.transaction((): CaptureIngestionResult => {
        const run = this.findRun(runId)
        if (!run || run.session_id !== sessionId || !this.isOpen(run)) return createResult('stale')
        const bindings = JSON.parse(run.realm_bindings_json) as Record<string, RealmBinding>
        const binding = Object.hasOwn(bindings, ownedRealm.realmId) ? bindings[ownedRealm.realmId] : undefined
        if (binding) {
          requireValid(binding.producerId === batch.producerId)
          requireValid(serializeCanonical(binding.realm) === serializeCanonical(ownedRealm))
        } else {
          requireValid(!Object.values(bindings).some((existing) => existing.producerId === batch.producerId))
        }

        const receiptIdentity = [runId, ownedRealm.realmId, batch.producerId] as const
        const findReceipt = this.db.prepare(`
          SELECT payload_hash FROM capture_receipts
          WHERE run_id = ? AND realm_id = ? AND producer_id = ? AND sequence = ?
        `)
        const maximum = this.db.prepare(`
          SELECT COALESCE(MAX(sequence), 0) AS sequence FROM capture_receipts
          WHERE run_id = ? AND realm_id = ? AND producer_id = ?
        `).get(...receiptIdentity) as { sequence: number }
        const newEvents: Array<{ event: CaptureEnvelope; payloadHash: string }> = []
        // Check the entire batch before binding or inserting anything.
        for (const event of batch.events) {
          const payloadHash = createHash('sha256').update(serializeCanonical(event)).digest('hex')
          const existing = findReceipt.get(...receiptIdentity, event.sequence) as { payload_hash: string } | undefined
          if (existing) {
            requireValid(existing.payload_hash === payloadHash)
          } else {
            requireValid(event.sequence > maximum.sequence)
            newEvents.push({ event, payloadHash })
          }
        }
        if (!binding) {
          Object.defineProperty(bindings, ownedRealm.realmId, {
            value: { producerId: batch.producerId, realm: ownedRealm },
            enumerable: true,
          })
          this.db.prepare('UPDATE capture_runs SET realm_bindings_json = ? WHERE run_id = ?')
            .run(JSON.stringify(bindings), runId)
        }
        const records: CaptureAcceptedRecord[] = []
        const insertReceipt = this.db.prepare(`
          INSERT INTO capture_receipts (run_id, realm_id, producer_id, sequence, payload_hash, committed_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        for (const { event, payloadHash } of newEvents) {
          const record = this.insertBusinessRecord(sessionId, runId, ownedRealm, event)
          if (record) records.push({ stream: event.stream, record })
          insertReceipt.run(...receiptIdentity, event.sequence, payloadHash, Date.now())
        }
        return {
          receipt: {
            runId,
            producerId: batch.producerId,
            acknowledged: batch.events.map((event) => event.sequence),
            disposition: 'committed',
          },
          records,
        }
      }).immediate()
    } catch (error) {
      if (error instanceof InvalidCaptureBatch) return createResult('invalid')
      // SQLITE_BUSY, IO errors and commit failures must reach the retrying controller.
      throw error
    }
  }

  saveHealth(snapshot: CaptureHealthSnapshot): void {
    if (!isHealthSnapshot(snapshot, snapshot.sessionId)) throw new Error('Invalid capture health snapshot')
    this.db.transaction(() => {
      const previous = this.getHealth(snapshot.sessionId)
      if (previous.runId !== null && previous.runId !== snapshot.runId) return
      if (snapshot.runId !== null) {
        const run = this.findRun(snapshot.runId)
        if (!run || run.session_id !== snapshot.sessionId) throw new Error('Health snapshot has an invalid run identity')
        const activeRun = this.db.prepare(`
          SELECT run_id FROM capture_runs WHERE session_id = ? AND state IN ('active', 'draining')
        `).get(snapshot.sessionId) as { run_id: string } | undefined
        if (activeRun && activeRun.run_id !== snapshot.runId) return
        if (!this.isOpen(run) && (snapshot.state === 'healthy' || snapshot.state === 'starting')) return
      } else if (previous.runId !== null) {
        return
      }
      if (previous.runId === snapshot.runId && previous.revision > snapshot.revision) return
      this.writeHealth({ ...snapshot, gaps: mergeGaps(previous.gaps, snapshot.gaps) })
    }).immediate()
  }

  getHealth(sessionId: string): CaptureHealthSnapshot {
    const row = this.db.prepare('SELECT snapshot_json FROM capture_health WHERE session_id = ?')
      .get(sessionId) as { snapshot_json: string } | undefined
    if (row) {
      try {
        const snapshot: unknown = JSON.parse(row.snapshot_json)
        if (isHealthSnapshot(snapshot, sessionId)) return snapshot
      } catch {
        // Missing or unreadable historical health cannot be represented as healthy.
      }
    }
    return createUnknownHealth(sessionId)
  }

  clearSession(sessionId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM capture_health WHERE session_id = ?').run(sessionId)
      // Receipt deletion is explicit as well as cascading for connections without FK enforcement.
      this.db.prepare('DELETE FROM capture_receipts WHERE run_id IN (SELECT run_id FROM capture_runs WHERE session_id = ?)')
        .run(sessionId)
      this.db.prepare('DELETE FROM capture_runs WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM js_hooks WHERE session_id = ? AND run_id IS NOT NULL').run(sessionId)
      this.db.prepare('DELETE FROM interaction_events WHERE session_id = ? AND run_id IS NOT NULL').run(sessionId)
    }).immediate()
  }

  recoverInterruptedRuns(): void {
    this.db.transaction(() => {
      const interruptedRuns = this.db.prepare("SELECT run_id FROM capture_runs WHERE state IN ('active', 'draining')")
        .all() as Array<{ run_id: string }>
      for (const run of interruptedRuns) this.endRun(run.run_id, 'interrupted', 'Capture process exited before the run was sealed')
    }).immediate()
  }

  private findRun(runId: string): CaptureRunRow | undefined {
    return this.db.prepare('SELECT * FROM capture_runs WHERE run_id = ?').get(runId) as CaptureRunRow | undefined
  }

  private isOpen(run: CaptureRunRow): boolean {
    return run.state === 'active' || run.state === 'draining'
  }

  private writeHealth(snapshot: CaptureHealthSnapshot): void {
    this.db.prepare(`
      INSERT INTO capture_health (session_id, snapshot_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at
    `).run(snapshot.sessionId, JSON.stringify(snapshot), Date.now())
  }

  private insertBusinessRecord(
    sessionId: string,
    runId: string,
    realm: CaptureRealmInfo,
    event: CaptureEnvelope,
  ): Record<string, unknown> | null {
    if (event.stream === 'control') return null
    const payload = event.payload
    const serializeValue = (value: unknown): string | null => {
      if (value == null) return null
      return typeof value === 'string' ? value : JSON.stringify(value)
    }
    if (event.stream === 'hook') {
      return this.db.prepare(`
        INSERT INTO js_hooks (
          session_id, timestamp, hook_type, function_name, arguments, result, call_stack,
          related_request_id, run_id, realm_id, producer_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?) RETURNING *
      `).get(
        sessionId, payload.timestamp, payload.hookType, payload.functionName,
        serializeValue(payload.arguments), serializeValue(payload.result), payload.callStack ?? null,
        runId, realm.realmId, event.sequence,
      ) as Record<string, unknown>
    }
    const nextSequence = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM interaction_events WHERE session_id = ?
    `).get(sessionId) as { sequence: number }
    return this.db.prepare(`
      INSERT INTO interaction_events (
        session_id, sequence, type, timestamp, x, y, viewport_x, viewport_y,
        selector, xpath, tag_name, element_text, attributes, bounding_rect,
        input_value, key, scroll_x, scroll_y, scroll_dx, scroll_dy,
        url, page_title, path, created_at, run_id, realm_id, producer_sequence
      ) VALUES (
        @session_id, @sequence, @type, @timestamp, @x, @y, @viewport_x, @viewport_y,
        @selector, @xpath, @tag_name, @element_text, @attributes, @bounding_rect,
        @input_value, @key, @scroll_x, @scroll_y, @scroll_dx, @scroll_dy,
        @url, @page_title, @path, @created_at, @run_id, @realm_id, @producer_sequence
      ) RETURNING *
    `).get({
      session_id: sessionId,
      sequence: nextSequence.sequence,
      type: payload.interactionType,
      timestamp: payload.timestamp,
      x: payload.x ?? null,
      y: payload.y ?? null,
      viewport_x: payload.viewportX ?? null,
      viewport_y: payload.viewportY ?? null,
      selector: payload.selector ?? null,
      xpath: payload.xpath ?? null,
      tag_name: payload.tagName ?? null,
      element_text: payload.elementText ?? null,
      attributes: payload.attributes == null ? null : JSON.stringify(payload.attributes),
      bounding_rect: payload.boundingRect == null ? null : JSON.stringify(payload.boundingRect),
      input_value: payload.inputValue ?? null,
      key: payload.key ?? null,
      scroll_x: payload.scrollX ?? null,
      scroll_y: payload.scrollY ?? null,
      scroll_dx: payload.scrollDX ?? null,
      scroll_dy: payload.scrollDY ?? null,
      url: payload.url,
      page_title: payload.pageTitle ?? null,
      path: payload.path == null ? null : JSON.stringify(payload.path),
      created_at: Date.now(),
      run_id: runId,
      realm_id: realm.realmId,
      producer_sequence: event.sequence,
    }) as Record<string, unknown>
  }
}
