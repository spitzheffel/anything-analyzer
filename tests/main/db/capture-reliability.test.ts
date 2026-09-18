import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureReliabilityRepo } from '../../../src/main/db/capture-reliability-repo'
import { migrateAddCaptureReliability, runMigrations } from '../../../src/main/db/migrations'
import type {
  CaptureBatch,
  CaptureEnvelope,
  CaptureHealthSnapshot,
  CaptureRealmInfo,
} from '../../../src/shared/capture-protocol'

vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))
import { backupBeforeCaptureReliabilityMigration } from '../../../src/main/db/database'

// Native ABI failures intentionally fail this critical suite. Use the Electron runner.
const realm: CaptureRealmInfo = {
  realmId: 'realm-one',
  kind: 'document',
  targetId: 'target-one',
  frameId: 'frame-one',
  tabId: 'trusted-tab',
  earlyInjection: true,
}

function createHook(sequence = 1): CaptureEnvelope {
  return {
    stream: 'hook',
    sequence,
    timestamp: 1000 + sequence,
    payload: {
      type: 'ar-hook',
      hookType: 'fetch',
      functionName: 'window.fetch',
      arguments: '{"url":"https://example.com"}',
      result: null,
      callStack: 'test stack',
      timestamp: 1000 + sequence,
    },
  }
}

function createInteraction(sequence = 2): CaptureEnvelope {
  return {
    stream: 'interaction',
    sequence,
    timestamp: 1000 + sequence,
    payload: {
      type: 'ar-interaction',
      interactionType: 'click',
      timestamp: 1000 + sequence,
      x: 20,
      y: 30,
      viewportX: 15,
      viewportY: 25,
      selector: '#submit',
      tagName: 'button',
      attributes: { id: 'submit' },
      boundingRect: { x: 10, y: 20, width: 40, height: 50 },
      url: 'https://example.com',
      pageTitle: 'Example',
      path: [{ x: 15, y: 25, t: 1000 }],
      sessionId: 'attacker-session',
      session_id: 'attacker-session',
      tabId: 'attacker-tab',
      run_id: 'attacker-run',
      realm_id: 'attacker-realm',
    },
  }
}

function createBatch(events: CaptureEnvelope[] = [createHook()], runId = 'run-one', producerId = 'producer-one'): CaptureBatch {
  return {
    protocolVersion: 1,
    runId,
    producerId,
    events,
    status: {
      installed: { fetch: 'installed' },
      pendingEvents: events.length,
      pendingBytes: 100,
      generatedSequence: Math.max(0, ...events.map((event) => event.sequence)),
      droppedEvents: 0,
      droppedThroughSequence: 0,
      recording: true,
    },
  }
}

function createHealth(sessionId = 'session-one', runId = 'run-one'): CaptureHealthSnapshot {
  return {
    sessionId,
    runId,
    revision: 1,
    state: 'healthy',
    network: 'running',
    workerCoverage: 'unknown',
    realms: [],
    gaps: [],
    persistenceError: null,
  }
}

describe('Durable capture reliability persistence', () => {
  let temporaryDirectory: string
  let databasePath: string
  let database: Database.Database
  let repository: CaptureReliabilityRepo

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'capture-reliability-'))
    databasePath = join(temporaryDirectory, 'capture.db')
    database = new Database(databasePath)
    database.pragma('journal_mode = WAL')
    database.pragma('foreign_keys = ON')
    runMigrations(database)
    database.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)').run('session-one', 1000)
    database.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)').run('session-two', 1000)
    repository = new CaptureReliabilityRepo(database)
    repository.beginRun('session-one', 'run-one')
  })

  afterEach(() => {
    if (database?.open) database.close()
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  function countRows(tableName: 'capture_receipts' | 'js_hooks' | 'interaction_events'): number {
    return (database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }).count
  }

  it('returns actual committed database rows, normalizes old payloads and owns provenance', () => {
    const result = repository.acceptBatch('session-one', 'run-one', realm, createBatch([
      createHook(), createInteraction(), { stream: 'control', sequence: 3, timestamp: 1003, payload: { installed: true } },
    ]))
    expect(database.pragma('synchronous', { simple: true })).toBe(2)
    expect(database.inTransaction).toBe(false)
    expect(result.receipt).toMatchObject({ disposition: 'committed', acknowledged: [1, 2, 3] })
    expect(result.records).toHaveLength(2)
    expect(result.records[0].record).toEqual(database.prepare('SELECT * FROM js_hooks').get())
    expect(result.records[1].record).toEqual(database.prepare('SELECT * FROM interaction_events').get())
    expect(result.records[1].record).toMatchObject({
      id: 1, session_id: 'session-one', sequence: 1, type: 'click', viewport_x: 15,
      run_id: 'run-one', realm_id: 'realm-one', producer_sequence: 2,
      attributes: '{"id":"submit"}', path: '[{"x":15,"y":25,"t":1000}]',
    })
    expect(result.records[1].record).not.toHaveProperty('tabId')
    expect(countRows('capture_receipts')).toBe(3)
  })

  it('acknowledges retransmissions without duplicate rows or UI records, including overlaps', () => {
    const batch = createBatch([createHook(), createInteraction()])
    repository.acceptBatch('session-one', 'run-one', realm, batch)
    const duplicate = repository.acceptBatch('session-one', 'run-one', realm, batch)
    expect(duplicate).toMatchObject({ receipt: { disposition: 'committed', acknowledged: [1, 2] }, records: [] })
    const overlapping = repository.acceptBatch('session-one', 'run-one', realm, createBatch([
      createHook(), createInteraction(), createHook(3),
    ]))
    expect(overlapping.records).toHaveLength(1)
    expect(overlapping.receipt.acknowledged).toEqual([1, 2, 3])
    expect(countRows('js_hooks')).toBe(2)
    expect(countRows('interaction_events')).toBe(1)
  })

  it('rejects conflicting payloads atomically, while accepting reordered JSON keys', () => {
    const original = createHook()
    repository.acceptBatch('session-one', 'run-one', realm, createBatch([original]))
    const reordered = { ...original, payload: Object.fromEntries(Object.entries(original.payload).reverse()) }
    expect(repository.acceptBatch('session-one', 'run-one', realm, createBatch([reordered])).receipt.disposition).toBe('committed')
    const conflicting = { ...original, payload: { ...original.payload, result: 'different' } }
    expect(repository.acceptBatch('session-one', 'run-one', realm, createBatch([conflicting, createHook(2)])))
      .toMatchObject({ receipt: { disposition: 'invalid', acknowledged: [] }, records: [] })
    expect(countRows('js_hooks')).toBe(1)
    expect(countRows('capture_receipts')).toBe(1)
    const differentStream = { ...original, stream: 'control' as const }
    expect(repository.acceptBatch('session-one', 'run-one', realm, createBatch([differentStream])).receipt.disposition).toBe('invalid')
  })

  it.each(['receipt', 'business'])('rolls back every receipt, business row and producer binding on %s failure', (failureKind) => {
    if (failureKind === 'receipt') {
      database.exec(`CREATE TRIGGER fail_capture BEFORE INSERT ON capture_receipts
        WHEN NEW.sequence = 2 BEGIN SELECT RAISE(ABORT, 'simulated persistence failure'); END`)
    } else {
      database.exec(`CREATE TRIGGER fail_capture BEFORE INSERT ON interaction_events
        BEGIN SELECT RAISE(ABORT, 'simulated persistence failure'); END`)
    }
    const batch = createBatch([createHook(), createInteraction()])
    expect(() => repository.acceptBatch('session-one', 'run-one', realm, batch)).toThrow('simulated persistence failure')
    expect(countRows('js_hooks')).toBe(0)
    expect(countRows('interaction_events')).toBe(0)
    expect(countRows('capture_receipts')).toBe(0)
    expect(database.prepare('SELECT realm_bindings_json FROM capture_runs').get()).toEqual({ realm_bindings_json: '{}' })
    database.exec('DROP TRIGGER fail_capture')
    expect(repository.acceptBatch('session-one', 'run-one', realm, batch).receipt.acknowledged).toEqual([1, 2])
  })

  it('does not return an acknowledgement when the final COMMIT fails', () => {
    database.exec(`
      CREATE TABLE deferred_commit_check (
        session_id TEXT REFERENCES sessions(id) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE TRIGGER fail_final_commit AFTER INSERT ON capture_receipts BEGIN
        INSERT INTO deferred_commit_check VALUES ('missing-session');
      END;
    `)
    expect(() => repository.acceptBatch('session-one', 'run-one', realm, createBatch())).toThrow(/FOREIGN KEY/)
    expect(database.inTransaction).toBe(false)
    expect(countRows('js_hooks')).toBe(0)
    expect(countRows('capture_receipts')).toBe(0)
    expect(database.prepare('SELECT realm_bindings_json FROM capture_runs').get()).toEqual({ realm_bindings_json: '{}' })
    database.exec('DROP TRIGGER fail_final_commit')
    expect(repository.acceptBatch('session-one', 'run-one', realm, createBatch()).receipt.acknowledged).toEqual([1])
  })

  it('propagates database contention for retry instead of acknowledging uncommitted data', () => {
    const competingConnection = new Database(databasePath)
    competingConnection.exec('BEGIN IMMEDIATE')
    database.pragma('busy_timeout = 1')
    try {
      expect(() => repository.acceptBatch('session-one', 'run-one', realm, createBatch())).toThrow(/locked/)
    } finally {
      competingConnection.exec('ROLLBACK')
      competingConnection.close()
    }
    expect(countRows('capture_receipts')).toBe(0)
    expect(repository.acceptBatch('session-one', 'run-one', realm, createBatch()).receipt.disposition).toBe('committed')
  })

  it('cannot acknowledge an outer transaction savepoint', () => {
    expect(() => database.transaction(() => {
      repository.acceptBatch('session-one', 'run-one', realm, createBatch())
    })()).toThrow(/own commit boundary/)
    expect(countRows('capture_receipts')).toBe(0)
  })

  it('rejects schema, version, bounds and stream violations without acknowledging or binding', () => {
    const invalidBatches: CaptureBatch[] = [
      { ...createBatch(), protocolVersion: 2 } as unknown as CaptureBatch,
      { ...createBatch(), runId: 'different-run' },
      { ...createBatch(), status: { ...createBatch().status, pendingEvents: -1 } },
      createBatch([createHook(), createHook()]),
      createBatch([createHook(2), createHook(1)]),
      createBatch([{ ...createHook(), sequence: 0 }]),
      createBatch([{ ...createHook(), payload: { ...createHook().payload, hookType: 'unknown-hook' } }]),
      createBatch([{ ...createHook(), stream: 'network' } as unknown as CaptureEnvelope]),
      createBatch([{ ...createHook(), payload: { ...createHook().payload, arguments: 'x'.repeat(256 * 1024) } }]),
      createBatch(Array.from({ length: 257 }, (_, index) => createHook(index + 1))),
      createBatch(Array.from({ length: 12 }, (_, index) => ({
        ...createHook(index + 1), payload: { ...createHook(index + 1).payload, arguments: 'x'.repeat(200 * 1024) },
      }))),
      createBatch([{ ...createInteraction(1), payload: { ...createInteraction(1).payload, viewportX: '20' } }]),
      createBatch([{ ...createInteraction(1), payload: { ...createInteraction(1).payload, path: [{ x: 1, y: 2, t: 'bad' }] } }]),
      { ...createBatch(), status: { ...createBatch().status, generatedSequence: 0 } },
    ]
    for (const batch of invalidBatches) {
      expect(repository.acceptBatch('session-one', 'run-one', realm, batch))
        .toMatchObject({ receipt: { disposition: 'invalid', acknowledged: [] }, records: [] })
    }
    const workerRealm = { ...realm, kind: 'worker' as const, frameId: null, tabId: null }
    expect(repository.acceptBatch('session-one', 'run-one', workerRealm, createBatch([createInteraction(1)]))
      .receipt.disposition).toBe('invalid')
    expect(countRows('capture_receipts')).toBe(0)
    expect(database.prepare('SELECT realm_bindings_json FROM capture_runs').get()).toEqual({ realm_bindings_json: '{}' })
  })

  it('binds each producer immutably to its run and realm, including empty status batches', () => {
    repository.acceptBatch('session-one', 'run-one', realm, createBatch([]))
    expect(repository.acceptBatch('session-one', 'run-one', realm, createBatch([], 'run-one', 'new-producer'))
      .receipt.disposition).toBe('invalid')
    expect(repository.acceptBatch('session-one', 'run-one', { ...realm, targetId: 'other-target' }, createBatch())
      .receipt.disposition).toBe('invalid')
    expect(repository.acceptBatch('session-one', 'run-one', { ...realm, realmId: 'other-realm' }, createBatch())
      .receipt.disposition).toBe('invalid')
    const otherRealm = { ...realm, realmId: 'other-realm' }
    expect(repository.acceptBatch('session-one', 'run-one', otherRealm, createBatch([], 'run-one', 'other-producer'))
      .receipt.disposition).toBe('committed')
  })

  it('permits explicit sequence gaps but not unseen older sequences', () => {
    expect(repository.acceptBatch('session-one', 'run-one', realm, createBatch([createHook(5)])).receipt.disposition).toBe('committed')
    expect(repository.acceptBatch('session-one', 'run-one', realm, createBatch([createHook(4)])))
      .toMatchObject({ receipt: { disposition: 'invalid', acknowledged: [] }, records: [] })
  })

  it('isolates sessions and sealed runs, accepting draining runs until sealing', () => {
    expect(repository.acceptBatch('session-two', 'run-one', realm, createBatch()).receipt.disposition).toBe('stale')
    expect(repository.acceptBatch('session-one', 'missing-run', realm, createBatch([], 'missing-run')).receipt.disposition).toBe('stale')
    database.prepare("UPDATE capture_runs SET state = 'draining' WHERE run_id = ?").run('run-one')
    repository.acceptBatch('session-one', 'run-one', realm, createBatch())
    repository.endRun('run-one', 'paused', 'User paused capture')
    expect(repository.acceptBatch('session-one', 'run-one', realm, createBatch()))
      .toMatchObject({ receipt: { disposition: 'stale', acknowledged: [] }, records: [] })
    expect(() => repository.beginRun('session-one', 'run-one')).toThrow(/cannot be reused/)
    repository.beginRun('session-one', 'run-two')
    expect(repository.acceptBatch('session-one', 'run-two', realm, createBatch([createHook()], 'run-two')).records).toHaveLength(1)
    repository.saveHealth(createHealth())
    expect(repository.getHealth('session-one').runId).toBe('run-two')
  })

  it('persists health and gap history across revisions, runs and reopening without fake health', () => {
    expect(repository.getHealth('session-two')).toMatchObject({ state: 'unknown', network: 'unknown', workerCoverage: 'unknown' })
    const gap = {
      runId: 'run-one', realmId: realm.realmId, startedAt: 1100, endedAt: null,
      reason: 'Buffer overflow', certainty: 'known-loss' as const, droppedEvents: 2,
    }
    repository.saveHealth({ ...createHealth(), gaps: [gap] })
    repository.saveHealth({ ...createHealth(), revision: 2, gaps: [{ ...gap, endedAt: 1200, droppedEvents: 3 }] })
    repository.saveHealth({ ...createHealth(), revision: 3, gaps: [] })
    repository.saveHealth({ ...createHealth(), revision: 1, state: 'degraded' })
    expect(repository.getHealth('session-one')).toMatchObject({ revision: 3, state: 'healthy', gaps: [{ ...gap, endedAt: 1200, droppedEvents: 3 }] })
    repository.endRun('run-one', 'stopped')
    repository.saveHealth({ ...createHealth(), revision: 100 })
    expect(repository.getHealth('session-one').state).toBe('stopped')
    repository.beginRun('session-one', 'run-two')
    expect(repository.getHealth('session-one')).toMatchObject({ runId: 'run-two', state: 'starting', gaps: [{ ...gap, endedAt: 1200, droppedEvents: 3 }] })
    database.close()
    database = new Database(databasePath)
    repository = new CaptureReliabilityRepo(database)
    expect(repository.getHealth('session-one').gaps).toHaveLength(1)
  })

  it('returns unknown for malformed historical health and still records interruption recovery', () => {
    database.prepare('UPDATE capture_health SET snapshot_json = ? WHERE session_id = ?')
      .run('{"sessionId":"session-one","state":"healthy","realms":[],"gaps":[]}', 'session-one')
    expect(repository.getHealth('session-one')).toMatchObject({ state: 'unknown', network: 'unknown' })
    database.prepare('UPDATE capture_health SET snapshot_json = ? WHERE session_id = ?')
      .run('not json', 'session-one')
    repository.recoverInterruptedRuns()
    expect(repository.getHealth('session-one')).toMatchObject({
      runId: 'run-one', state: 'degraded', gaps: [{ certainty: 'unknown-coverage' }],
    })
  })

  it('retains durable deduplication and marks unsealed reopened runs interrupted exactly once', () => {
    repository.acceptBatch('session-one', 'run-one', realm, createBatch())
    repository.saveHealth(createHealth())
    database.close()
    database = new Database(databasePath)
    repository = new CaptureReliabilityRepo(database)
    expect(repository.acceptBatch('session-one', 'run-one', realm, createBatch()).records).toEqual([])
    database.prepare("UPDATE capture_runs SET state = 'draining' WHERE run_id = ?").run('run-one')
    repository.recoverInterruptedRuns()
    expect(database.prepare('SELECT state FROM capture_runs').get()).toEqual({ state: 'interrupted' })
    expect(repository.getHealth('session-one')).toMatchObject({
      state: 'degraded', network: 'stopped', gaps: [{ runId: 'run-one', certainty: 'unknown-coverage', droppedEvents: null }],
    })
    const recovered = repository.getHealth('session-one')
    repository.recoverInterruptedRuns()
    expect(repository.getHealth('session-one')).toEqual(recovered)
    expect(repository.acceptBatch('session-one', 'run-one', realm, createBatch()).receipt.disposition).toBe('stale')
  })

  it('clears only the requested session reliability data and leaves legacy rows intact', () => {
    repository.acceptBatch('session-one', 'run-one', realm, createBatch([createHook(), createInteraction()]))
    repository.beginRun('session-two', 'other-run')
    repository.acceptBatch('session-two', 'other-run', realm, createBatch([createHook()], 'other-run'))
    database.prepare(`INSERT INTO js_hooks (session_id, timestamp, hook_type, function_name)
      VALUES ('session-one', 1, 'fetch', 'legacy')`).run()
    repository.clearSession('session-one')
    expect(repository.getHealth('session-one').state).toBe('unknown')
    expect(database.prepare('SELECT session_id FROM capture_runs').all()).toEqual([{ session_id: 'session-two' }])
    expect(countRows('capture_receipts')).toBe(1)
    expect(countRows('interaction_events')).toBe(0)
    expect(database.prepare('SELECT function_name FROM js_hooks WHERE session_id = ?').all('session-one'))
      .toEqual([{ function_name: 'legacy' }])
    expect(repository.getHealth('session-two').runId).toBe('other-run')
  })

  it('migrates old history idempotently and backs up committed WAL data before changing schema', () => {
    const legacyPath = join(temporaryDirectory, 'legacy.db')
    const legacy = new Database(legacyPath)
    try {
      legacy.pragma('journal_mode = WAL')
      legacy.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY);
        CREATE TABLE requests (id TEXT PRIMARY KEY, session_id TEXT);
        CREATE TABLE js_hooks (id INTEGER PRIMARY KEY, session_id TEXT, function_name TEXT);
        CREATE TABLE interaction_events (id INTEGER PRIMARY KEY, session_id TEXT);
        INSERT INTO sessions VALUES ('old-session');
        INSERT INTO requests VALUES ('old-request', 'old-session');
        INSERT INTO js_hooks VALUES (1, 'old-session', 'old-hook');
        INSERT INTO interaction_events VALUES (1, 'old-session');
      `)
      const backupPath = backupBeforeCaptureReliabilityMigration(legacy)
      expect(backupPath).not.toBeNull()
      expect(backupBeforeCaptureReliabilityMigration(legacy)).toBe(backupPath)
      const backup = new Database(backupPath!, { readonly: true })
      try {
        expect(backup.prepare('SELECT * FROM requests').get()).toEqual({ id: 'old-request', session_id: 'old-session' })
        expect(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'capture_runs'").get()).toBeUndefined()
      } finally {
        backup.close()
      }
      migrateAddCaptureReliability(legacy)
      migrateAddCaptureReliability(legacy)
      expect(backupBeforeCaptureReliabilityMigration(legacy)).toBeNull()
      expect(legacy.prepare('SELECT * FROM requests').get()).toMatchObject({ body_status: 'unknown', body_error: null })
      expect(legacy.prepare('SELECT * FROM js_hooks').get()).toMatchObject({ function_name: 'old-hook', run_id: null, realm_id: null, producer_sequence: null })
      expect(new CaptureReliabilityRepo(legacy).getHealth('old-session')).toMatchObject({ state: 'unknown', runId: null, gaps: [] })
      runMigrations(database)
      expect(countRows('capture_receipts')).toBe(0)
    } finally {
      legacy.close()
    }
  })

  it('rolls back partially applied additive migrations if an old schema is inconsistent', () => {
    const inconsistent = new Database(':memory:')
    try {
      inconsistent.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE requests (id TEXT); CREATE TABLE js_hooks (id INTEGER);')
      expect(() => migrateAddCaptureReliability(inconsistent)).toThrow(/no such table/)
      expect(inconsistent.prepare("SELECT name FROM sqlite_master WHERE name = 'capture_runs'").get()).toBeUndefined()
      expect(inconsistent.prepare('PRAGMA table_info(requests)').all()).toHaveLength(1)
      expect(inconsistent.prepare('PRAGMA table_info(js_hooks)').all()).toHaveLength(1)
    } finally {
      inconsistent.close()
    }
  })
})
