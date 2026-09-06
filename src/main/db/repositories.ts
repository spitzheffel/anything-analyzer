import type Database from 'better-sqlite3'
import type {
  Session,
  CapturedRequest,
  JsHookRecord,
  StorageSnapshot,
  AnalysisReport,
  FingerprintProfile,
  AiRequestLog,
  InteractionEvent,
  InteractionType,
  SessionBrowserConfig,
  BrowserProfile,
  BrowserProfileState,
  BrowserTabState,
} from '@shared/types'

// ============================================================
// Sessions Repository
// ============================================================

export class SessionsRepo {
  private stmts: {
    insert: Database.Statement
    findById: Database.Statement
    findAll: Database.Statement
    updateStatus: Database.Statement
    delete: Database.Statement
  }

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO sessions (id, name, target_url, status, created_at, stopped_at)
         VALUES (@id, @name, @target_url, @status, @created_at, @stopped_at)`
      ),
      findById: db.prepare(`
        SELECT sessions.*,
               COALESCE(config.browser_backend, 'electron') AS browser_backend,
               COALESCE(config.capture_mode, 'deep') AS capture_mode,
               config.profile_id AS browser_profile_id,
               config.last_browser_version AS last_browser_version
        FROM sessions
        LEFT JOIN session_browser_config AS config ON config.session_id = sessions.id
        WHERE sessions.id = ?
      `),
      findAll: db.prepare(`
        SELECT sessions.*,
               COALESCE(config.browser_backend, 'electron') AS browser_backend,
               COALESCE(config.capture_mode, 'deep') AS capture_mode,
               config.profile_id AS browser_profile_id,
               config.last_browser_version AS last_browser_version
        FROM sessions
        LEFT JOIN session_browser_config AS config ON config.session_id = sessions.id
        ORDER BY sessions.created_at DESC
      `),
      updateStatus: db.prepare(
        'UPDATE sessions SET status = @status, stopped_at = @stopped_at WHERE id = @id'
      ),
      delete: db.prepare('DELETE FROM sessions WHERE id = ?')
    }
  }

  insert(session: Session): void {
    this.stmts.insert.run(session)
  }

  findById(id: string): Session | undefined {
    return this.stmts.findById.get(id) as Session | undefined
  }

  findAll(): Session[] {
    return this.stmts.findAll.all() as Session[]
  }

  updateStatus(id: string, status: string, stoppedAt: number | null = null): void {
    this.stmts.updateStatus.run({ id, status, stopped_at: stoppedAt })
  }

  delete(id: string): void {
    this.stmts.delete.run(id)
  }

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)()
  }
}

// ============================================================
// Session Browser Config Repository
// ============================================================

export class SessionBrowserConfigRepo {
  private stmts: {
    upsert: Database.Statement
    findBySessionId: Database.Statement
    delete: Database.Statement
  }

  constructor(private db: Database.Database) {
    this.stmts = {
      upsert: db.prepare(`
        INSERT INTO session_browser_config (
          session_id, browser_backend, capture_mode, profile_id,
          last_browser_version, created_at, updated_at
        ) VALUES (
          @session_id, @browser_backend, @capture_mode, @profile_id,
          @last_browser_version, @created_at, @updated_at
        )
        ON CONFLICT(session_id) DO UPDATE SET
          browser_backend = excluded.browser_backend,
          capture_mode = excluded.capture_mode,
          profile_id = excluded.profile_id,
          last_browser_version = excluded.last_browser_version,
          updated_at = excluded.updated_at
      `),
      findBySessionId: db.prepare(
        'SELECT * FROM session_browser_config WHERE session_id = ?'
      ),
      delete: db.prepare('DELETE FROM session_browser_config WHERE session_id = ?'),
    }
  }

  upsert(config: SessionBrowserConfig): void {
    this.stmts.upsert.run(config)
  }

  findBySessionId(sessionId: string): SessionBrowserConfig | null {
    return (this.stmts.findBySessionId.get(sessionId) as SessionBrowserConfig | undefined) ?? null
  }

  delete(sessionId: string): void {
    this.stmts.delete.run(sessionId)
  }
}

// ============================================================
// Requests Repository
// ============================================================

export class RequestsRepo {
  private stmts: {
    insert: Database.Statement
    updateResponse: Database.Statement
    findBySession: Database.Statement
    findById: Database.Statement
    getNextSequence: Database.Statement
    deleteBySession: Database.Statement
    countBySession: Database.Statement
  }

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO requests (id, session_id, sequence, timestamp, method, url, request_headers, request_body, content_type, initiator, source)
         VALUES (@id, @session_id, @sequence, @timestamp, @method, @url, @request_headers, @request_body, @content_type, @initiator, @source)`
      ),
      updateResponse: db.prepare(
        `UPDATE requests SET status_code = @status_code, response_headers = @response_headers,
         response_body = @response_body, content_type = @content_type, duration_ms = @duration_ms,
         is_streaming = @is_streaming, is_websocket = @is_websocket
         WHERE id = @id`
      ),
      findBySession: db.prepare(
        'SELECT * FROM requests WHERE session_id = ? ORDER BY sequence ASC'
      ),
      findById: db.prepare('SELECT * FROM requests WHERE id = ?'),
      getNextSequence: db.prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM requests WHERE session_id = ?'
      ),
      deleteBySession: db.prepare('DELETE FROM requests WHERE session_id = ?'),
      countBySession: db.prepare('SELECT COUNT(*) AS cnt FROM requests WHERE session_id = ?'),
    }
  }

  insert(data: Partial<CapturedRequest> & { source?: string }): void {
    this.stmts.insert.run({ ...data, source: data.source || 'cdp' })
  }

  countBySession(sessionId: string): number {
    const row = this.stmts.countBySession.get(sessionId) as { cnt: number } | undefined
    return row?.cnt ?? 0
  }

  updateResponse(data: {
    id: string
    status_code: number
    response_headers: string
    response_body: string | null
    content_type: string | null
    duration_ms: number
    is_streaming: number  // 0 or 1
    is_websocket: number  // 0 or 1
  }): void {
    this.stmts.updateResponse.run(data)
  }

  findBySession(sessionId: string): CapturedRequest[] {
    return this.stmts.findBySession.all(sessionId) as CapturedRequest[]
  }

  findById(id: string): CapturedRequest | undefined {
    return this.stmts.findById.get(id) as CapturedRequest | undefined
  }

  getNextSequence(sessionId: string): number {
    const row = this.stmts.getNextSequence.get(sessionId) as { next_seq: number }
    return row.next_seq
  }

  deleteBySession(sessionId: string): void {
    this.stmts.deleteBySession.run(sessionId)
  }

  /**
   * Find requests with dynamic filtering conditions.
   */
  findBySessionFiltered(sessionId: string, filters: {
    method?: string
    domain?: string
    statusCode?: number
    statusRange?: string
    contentType?: string
    urlPattern?: string
    limit?: number
  }): CapturedRequest[] {
    const conditions: string[] = ['session_id = ?']
    const params: unknown[] = [sessionId]

    if (filters.method) {
      conditions.push('method = ?')
      params.push(filters.method.toUpperCase())
    }

    if (filters.domain) {
      conditions.push('url LIKE ?')
      params.push(`%${filters.domain}%`)
    }

    if (filters.statusCode != null) {
      conditions.push('status_code = ?')
      params.push(filters.statusCode)
    } else if (filters.statusRange) {
      const prefix = filters.statusRange.charAt(0)
      if (/^[1-5]$/.test(prefix)) {
        conditions.push('status_code >= ? AND status_code < ?')
        params.push(Number(prefix) * 100, (Number(prefix) + 1) * 100)
      }
    }

    if (filters.contentType) {
      conditions.push('content_type LIKE ?')
      params.push(`%${filters.contentType}%`)
    }

    if (filters.urlPattern) {
      conditions.push('url LIKE ?')
      params.push(`%${filters.urlPattern}%`)
    }

    const limit = filters.limit && filters.limit > 0 ? filters.limit : 50
    const sql = `SELECT * FROM requests WHERE ${conditions.join(' AND ')} ORDER BY sequence ASC LIMIT ?`
    params.push(limit)

    return this.db.prepare(sql).all(...params) as CapturedRequest[]
  }
}

// ============================================================
// JS Hooks Repository
// ============================================================

export class JsHooksRepo {
  private stmts: {
    insert: Database.Statement
    findBySession: Database.Statement
    deleteBySession: Database.Statement
    countBySession: Database.Statement
  }

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO js_hooks (session_id, timestamp, hook_type, function_name, arguments, result, call_stack, related_request_id)
         VALUES (@session_id, @timestamp, @hook_type, @function_name, @arguments, @result, @call_stack, @related_request_id)`
      ),
      findBySession: db.prepare(
        'SELECT * FROM js_hooks WHERE session_id = ? ORDER BY timestamp ASC'
      ),
      deleteBySession: db.prepare('DELETE FROM js_hooks WHERE session_id = ?'),
      countBySession: db.prepare('SELECT COUNT(*) AS cnt FROM js_hooks WHERE session_id = ?'),
    }
  }

  insert(record: Omit<JsHookRecord, 'id'>): void {
    this.stmts.insert.run(record)
  }

  findBySession(sessionId: string): JsHookRecord[] {
    return this.stmts.findBySession.all(sessionId) as JsHookRecord[]
  }

  countBySession(sessionId: string): number {
    const row = this.stmts.countBySession.get(sessionId) as { cnt: number } | undefined
    return row?.cnt ?? 0
  }

  deleteBySession(sessionId: string): void {
    this.stmts.deleteBySession.run(sessionId)
  }
}

// ============================================================
// Storage Snapshots Repository
// ============================================================

export class StorageSnapshotsRepo {
  private stmts: {
    insert: Database.Statement
    findBySession: Database.Statement
    findLatest: Database.Statement
    deleteBySession: Database.Statement
  }

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO storage_snapshots (session_id, timestamp, domain, storage_type, data)
         VALUES (@session_id, @timestamp, @domain, @storage_type, @data)`
      ),
      findBySession: db.prepare(
        'SELECT * FROM storage_snapshots WHERE session_id = ? ORDER BY timestamp ASC'
      ),
      findLatest: db.prepare(
        `SELECT * FROM storage_snapshots
         WHERE session_id = ? AND storage_type = ?
         ORDER BY timestamp DESC LIMIT 1`
      ),
      deleteBySession: db.prepare('DELETE FROM storage_snapshots WHERE session_id = ?')
    }
  }

  insert(snapshot: Omit<StorageSnapshot, 'id'>): void {
    this.stmts.insert.run(snapshot)
  }

  findBySession(sessionId: string): StorageSnapshot[] {
    return this.stmts.findBySession.all(sessionId) as StorageSnapshot[]
  }

  findLatest(sessionId: string, storageType: string): StorageSnapshot | undefined {
    return this.stmts.findLatest.get(sessionId, storageType) as StorageSnapshot | undefined
  }

  deleteBySession(sessionId: string): void {
    this.stmts.deleteBySession.run(sessionId)
  }
}

// ============================================================
// Analysis Reports Repository
// ============================================================

export class AnalysisReportsRepo {
  private stmts: {
    insert: Database.Statement
    findBySession: Database.Statement
    findById: Database.Statement
    deleteBySession: Database.Statement
    deleteById: Database.Statement
    updateSpec: Database.Statement
    countBySession: Database.Statement
  }

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO analysis_reports (id, session_id, created_at, llm_provider, llm_model, prompt_tokens, completion_tokens, report_content, filter_prompt_tokens, filter_completion_tokens, purpose, spec_json, spec_error, enrichment_json)
         VALUES (@id, @session_id, @created_at, @llm_provider, @llm_model, @prompt_tokens, @completion_tokens, @report_content, @filter_prompt_tokens, @filter_completion_tokens, @purpose, @spec_json, @spec_error, @enrichment_json)`
      ),
      findBySession: db.prepare(
        'SELECT * FROM analysis_reports WHERE session_id = ? ORDER BY created_at DESC'
      ),
      findById: db.prepare('SELECT * FROM analysis_reports WHERE id = ?'),
      deleteBySession: db.prepare('DELETE FROM analysis_reports WHERE session_id = ?'),
      deleteById: db.prepare('DELETE FROM analysis_reports WHERE id = ?'),
      updateSpec: db.prepare(
        'UPDATE analysis_reports SET spec_json = ?, spec_error = ? WHERE id = ?'
      ),
      countBySession: db.prepare('SELECT COUNT(*) AS cnt FROM analysis_reports WHERE session_id = ?'),
    }
  }

  countBySession(sessionId: string): number {
    const row = this.stmts.countBySession.get(sessionId) as { cnt: number } | undefined
    return row?.cnt ?? 0
  }

  insert(report: AnalysisReport): void {
    this.stmts.insert.run({
      ...report,
      purpose: report.purpose ?? null,
      spec_json: report.spec_json ?? null,
      spec_error: report.spec_error ?? null,
      enrichment_json: report.enrichment_json ?? null,
    })
  }

  updateSpec(id: string, specJson: string | null, specError: string | null): void {
    this.stmts.updateSpec.run(specJson, specError, id)
  }

  findBySession(sessionId: string): AnalysisReport[] {
    return this.stmts.findBySession.all(sessionId) as AnalysisReport[]
  }

  findById(id: string): AnalysisReport | undefined {
    return this.stmts.findById.get(id) as AnalysisReport | undefined
  }

  deleteBySession(sessionId: string): void {
    this.stmts.deleteBySession.run(sessionId)
  }

  deleteById(id: string): void {
    this.stmts.deleteById.run(id)
  }
}

// ============================================================
// Fingerprint Profiles Repository
// ============================================================

export class FingerprintProfilesRepo {
  private stmts: {
    upsert: Database.Statement
    findBySessionId: Database.Statement
    delete: Database.Statement
  }

  constructor(private db: Database.Database) {
    this.stmts = {
      upsert: db.prepare(
        `INSERT OR REPLACE INTO fingerprint_profiles (session_id, profile_json)
         VALUES (@session_id, @profile_json)`
      ),
      findBySessionId: db.prepare(
        'SELECT profile_json FROM fingerprint_profiles WHERE session_id = ?'
      ),
      delete: db.prepare('DELETE FROM fingerprint_profiles WHERE session_id = ?')
    }
  }

  upsert(sessionId: string, profile: FingerprintProfile): void {
    this.stmts.upsert.run({
      session_id: sessionId,
      profile_json: JSON.stringify(profile),
    })
  }

  findBySessionId(sessionId: string): FingerprintProfile | null {
    const row = this.stmts.findBySessionId.get(sessionId) as { profile_json: string } | undefined
    if (!row) return null
    return JSON.parse(row.profile_json)
  }

  delete(sessionId: string): void {
    this.stmts.delete.run(sessionId)
  }
}

// ============================================================
// External Browser Profiles Repository
// ============================================================

export class BrowserProfilesRepo {
  private stmts: {
    insert: Database.Statement
    upsert: Database.Statement
    findById: Database.Statement
    findByProfileKey: Database.Statement
    findAll: Database.Statement
    findByState: Database.Statement
    update: Database.Statement
    updateState: Database.Statement
    touchLastUsed: Database.Statement
    delete: Database.Statement
  }

  constructor(private db: Database.Database) {
    const columns = `
      id, display_name, profile_key, cloak_seed, state, last_used_at,
      retained_at, last_error, created_at, updated_at
    `
    this.stmts = {
      insert: db.prepare(`
        INSERT INTO browser_profiles (${columns}) VALUES (
          @id, @display_name, @profile_key, @cloak_seed, @state,
          @last_used_at, @retained_at, @last_error, @created_at, @updated_at
        )
      `),
      upsert: db.prepare(`
        INSERT INTO browser_profiles (${columns}) VALUES (
          @id, @display_name, @profile_key, @cloak_seed, @state,
          @last_used_at, @retained_at, @last_error, @created_at, @updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          profile_key = excluded.profile_key,
          cloak_seed = excluded.cloak_seed,
          state = excluded.state,
          last_used_at = excluded.last_used_at,
          retained_at = excluded.retained_at,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `),
      findById: db.prepare('SELECT * FROM browser_profiles WHERE id = ?'),
      findByProfileKey: db.prepare('SELECT * FROM browser_profiles WHERE profile_key = ?'),
      findAll: db.prepare('SELECT * FROM browser_profiles ORDER BY created_at ASC'),
      findByState: db.prepare(
        'SELECT * FROM browser_profiles WHERE state = ? ORDER BY last_used_at DESC, created_at ASC'
      ),
      update: db.prepare(`
        UPDATE browser_profiles SET
          display_name = @display_name,
          profile_key = @profile_key,
          cloak_seed = @cloak_seed,
          state = @state,
          last_used_at = @last_used_at,
          retained_at = @retained_at,
          last_error = @last_error,
          updated_at = @updated_at
        WHERE id = @id
      `),
      updateState: db.prepare(`
        UPDATE browser_profiles
        SET state = @state,
            retained_at = CASE
              WHEN @state = 'retained' THEN @updated_at
              WHEN @state = 'attached' THEN NULL
              ELSE retained_at
            END,
            last_error = @last_error,
            updated_at = @updated_at
        WHERE id = @id
      `),
      touchLastUsed: db.prepare(`
        UPDATE browser_profiles
        SET last_used_at = @last_used_at, updated_at = @updated_at
        WHERE id = @id
      `),
      delete: db.prepare('DELETE FROM browser_profiles WHERE id = ?'),
    }
  }

  insert(profile: BrowserProfile): void {
    this.stmts.insert.run(profile)
  }

  upsert(profile: BrowserProfile): void {
    this.stmts.upsert.run(profile)
  }

  findById(id: string): BrowserProfile | null {
    return (this.stmts.findById.get(id) as BrowserProfile | undefined) ?? null
  }

  findByProfileKey(profileKey: string): BrowserProfile | null {
    return (this.stmts.findByProfileKey.get(profileKey) as BrowserProfile | undefined) ?? null
  }

  findAll(): BrowserProfile[] {
    return this.stmts.findAll.all() as BrowserProfile[]
  }

  findByState(state: BrowserProfileState): BrowserProfile[] {
    return this.stmts.findByState.all(state) as BrowserProfile[]
  }

  update(profile: BrowserProfile): void {
    this.stmts.update.run(profile)
  }

  updateState(
    id: string,
    state: BrowserProfileState,
    lastError: string | null = null,
    updatedAt: number = Date.now(),
  ): void {
    this.stmts.updateState.run({
      id,
      state,
      last_error: lastError,
      updated_at: updatedAt,
    })
  }

  touchLastUsed(id: string, lastUsedAt: number = Date.now()): void {
    this.stmts.touchLastUsed.run({
      id,
      last_used_at: lastUsedAt,
      updated_at: lastUsedAt,
    })
  }

  delete(id: string): void {
    this.stmts.delete.run(id)
  }
}

// ============================================================
// Persisted Browser Tabs Repository
// ============================================================

type BrowserTabRow = Omit<BrowserTabState, 'active'> & { active: number }

function mapBrowserTab(row: BrowserTabRow): BrowserTabState {
  return { ...row, active: row.active === 1 }
}

export class BrowserTabsRepo {
  private stmts: {
    upsert: Database.Statement
    findById: Database.Statement
    findByProfileId: Database.Statement
    clearActive: Database.Statement
    markActive: Database.Statement
    delete: Database.Statement
    deleteByProfileId: Database.Statement
  }

  constructor(private db: Database.Database) {
    this.stmts = {
      upsert: db.prepare(`
        INSERT INTO browser_tabs (
          profile_id, id, url, title, position, active, updated_at
        ) VALUES (
          @profile_id, @id, @url, @title, @position, @active, @updated_at
        )
        ON CONFLICT(profile_id, id) DO UPDATE SET
          url = excluded.url,
          title = excluded.title,
          position = excluded.position,
          active = excluded.active,
          updated_at = excluded.updated_at
      `),
      findById: db.prepare(
        'SELECT * FROM browser_tabs WHERE profile_id = ? AND id = ?'
      ),
      findByProfileId: db.prepare(
        'SELECT * FROM browser_tabs WHERE profile_id = ? ORDER BY position ASC, id ASC'
      ),
      clearActive: db.prepare('UPDATE browser_tabs SET active = 0 WHERE profile_id = ?'),
      markActive: db.prepare(
        'UPDATE browser_tabs SET active = 1, updated_at = ? WHERE profile_id = ? AND id = ?'
      ),
      delete: db.prepare('DELETE FROM browser_tabs WHERE profile_id = ? AND id = ?'),
      deleteByProfileId: db.prepare('DELETE FROM browser_tabs WHERE profile_id = ?'),
    }
  }

  upsert(tab: BrowserTabState): void {
    this.stmts.upsert.run({ ...tab, active: tab.active ? 1 : 0 })
  }

  replaceForProfile(profileId: string, tabs: BrowserTabState[]): void {
    this.db.transaction(() => {
      this.stmts.deleteByProfileId.run(profileId)
      for (const tab of tabs) {
        if (tab.profile_id !== profileId) {
          throw new Error(`Browser tab ${tab.id} belongs to a different profile`)
        }
        this.upsert(tab)
      }
    })()
  }

  findById(profileId: string, id: string): BrowserTabState | null {
    const row = this.stmts.findById.get(profileId, id) as BrowserTabRow | undefined
    return row ? mapBrowserTab(row) : null
  }

  findByProfileId(profileId: string): BrowserTabState[] {
    return (this.stmts.findByProfileId.all(profileId) as BrowserTabRow[]).map(mapBrowserTab)
  }

  setActive(profileId: string, id: string, updatedAt: number = Date.now()): void {
    this.db.transaction(() => {
      this.stmts.clearActive.run(profileId)
      this.stmts.markActive.run(updatedAt, profileId, id)
    })()
  }

  delete(profileId: string, id: string): void {
    this.stmts.delete.run(profileId, id)
  }

  deleteByProfileId(profileId: string): void {
    this.stmts.deleteByProfileId.run(profileId)
  }
}

// ============================================================
// Chat Messages Repository
// ============================================================

export class ChatMessagesRepo {
  private stmts: {
    insert: Database.Statement
    findByReport: Database.Statement
    deleteByReport: Database.Statement
  }

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO chat_messages (report_id, role, content, created_at)
         VALUES (@report_id, @role, @content, @created_at)`
      ),
      findByReport: db.prepare(
        'SELECT role, content FROM chat_messages WHERE report_id = ? ORDER BY id ASC'
      ),
      deleteByReport: db.prepare('DELETE FROM chat_messages WHERE report_id = ?')
    }
  }

  append(reportId: string, role: string, content: string): void {
    this.stmts.insert.run({
      report_id: reportId,
      role,
      content,
      created_at: Date.now(),
    })
  }

  insertMany(reportId: string, messages: Array<{ role: string; content: string }>): void {
    const now = Date.now()
    const insertMany = this.db.transaction((msgs: Array<{ role: string; content: string }>) => {
      for (const msg of msgs) {
        this.stmts.insert.run({
          report_id: reportId,
          role: msg.role,
          content: msg.content,
          created_at: now,
        })
      }
    })
    insertMany(messages)
  }

  findByReport(reportId: string): Array<{ role: string; content: string }> {
    return this.stmts.findByReport.all(reportId) as Array<{ role: string; content: string }>
  }

  deleteByReport(reportId: string): void {
    this.stmts.deleteByReport.run(reportId)
  }
}

// ============================================================
// AI Request Log Repository
// ============================================================

/** Columns returned in list queries (excludes large body fields) */
const AI_LOG_LIST_COLUMNS = `
  id, session_id, report_id, type, provider, model,
  request_url, request_method, status_code,
  prompt_tokens, completion_tokens, duration_ms, error, created_at
`.trim();

export class AiRequestLogRepo {
  private stmts: {
    insert: Database.Statement;
    findBySession: Database.Statement;
    findAll: Database.Statement;
    findById: Database.Statement;
    deleteBySession: Database.Statement;
    updateTokens: Database.Statement;
    updateTokensById: Database.Statement;
    updateResponseBodyById: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO ai_request_logs
         (session_id, report_id, type, provider, model,
          request_url, request_method, request_headers, request_body,
          status_code, response_headers, response_body,
          prompt_tokens, completion_tokens, duration_ms, error, created_at)
         VALUES
         (@session_id, @report_id, @type, @provider, @model,
          @request_url, @request_method, @request_headers, @request_body,
          @status_code, @response_headers, @response_body,
          @prompt_tokens, @completion_tokens, @duration_ms, @error, @created_at)`
      ),
      findBySession: db.prepare(
        `SELECT ${AI_LOG_LIST_COLUMNS} FROM ai_request_logs
         WHERE session_id = ? ORDER BY created_at DESC`
      ),
      findAll: db.prepare(
        `SELECT ${AI_LOG_LIST_COLUMNS} FROM ai_request_logs
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ),
      findById: db.prepare(
        'SELECT * FROM ai_request_logs WHERE id = ?'
      ),
      deleteBySession: db.prepare(
        'DELETE FROM ai_request_logs WHERE session_id = ?'
      ),
      updateTokens: db.prepare(
        `UPDATE ai_request_logs SET prompt_tokens = ?, completion_tokens = ?
         WHERE id = (SELECT MAX(id) FROM ai_request_logs WHERE session_id = ? AND type = ?)`
      ),
      updateTokensById: db.prepare(
        'UPDATE ai_request_logs SET prompt_tokens = ?, completion_tokens = ? WHERE id = ?'
      ),
      updateResponseBodyById: db.prepare(
        'UPDATE ai_request_logs SET response_body = ?, duration_ms = ? WHERE id = ?'
      ),
    };
  }

  insert(log: Omit<AiRequestLog, 'id'>): number {
    return Number(this.stmts.insert.run(log).lastInsertRowid);
  }

  findBySession(sessionId: string): AiRequestLog[] {
    return this.stmts.findBySession.all(sessionId) as AiRequestLog[];
  }

  findAll(limit: number, offset: number): AiRequestLog[] {
    return this.stmts.findAll.all(limit, offset) as AiRequestLog[];
  }

  findById(id: number): AiRequestLog | null {
    return (this.stmts.findById.get(id) as AiRequestLog) ?? null;
  }

  deleteBySession(sessionId: string): void {
    this.stmts.deleteBySession.run(sessionId);
  }

  updateLatestTokens(sessionId: string, type: string, promptTokens: number, completionTokens: number): void {
    this.stmts.updateTokens.run(promptTokens, completionTokens, sessionId, type);
  }

  updateTokensById(id: number, promptTokens: number, completionTokens: number): void {
    this.stmts.updateTokensById.run(promptTokens, completionTokens, id);
  }

  updateResponseBodyById(id: number, responseBody: string, durationMs: number): void {
    this.stmts.updateResponseBodyById.run(responseBody, durationMs, id);
  }
}

// ============================================================
// Interaction Events Repository
// ============================================================

export class InteractionEventsRepo {
  private stmts: {
    insert: Database.Statement;
    getNextSequence: Database.Statement;
    findBySession: Database.Statement;
    findBySessionAndType: Database.Statement;
    findById: Database.Statement;
    deleteBySession: Database.Statement;
    count: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO interaction_events
         (session_id, sequence, type, timestamp, x, y, viewport_x, viewport_y,
          selector, xpath, tag_name, element_text, attributes, bounding_rect,
          input_value, key, scroll_x, scroll_y, scroll_dx, scroll_dy,
          url, page_title, path, created_at)
         VALUES
         (@session_id, @sequence, @type, @timestamp, @x, @y, @viewport_x, @viewport_y,
          @selector, @xpath, @tag_name, @element_text, @attributes, @bounding_rect,
          @input_value, @key, @scroll_x, @scroll_y, @scroll_dx, @scroll_dy,
          @url, @page_title, @path, @created_at)`
      ),
      getNextSequence: db.prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM interaction_events WHERE session_id = ?'
      ),
      findBySession: db.prepare(
        'SELECT * FROM interaction_events WHERE session_id = ? ORDER BY sequence ASC LIMIT ?'
      ),
      findBySessionAndType: db.prepare(
        'SELECT * FROM interaction_events WHERE session_id = ? AND type = ? ORDER BY sequence ASC'
      ),
      findById: db.prepare('SELECT * FROM interaction_events WHERE id = ?'),
      deleteBySession: db.prepare('DELETE FROM interaction_events WHERE session_id = ?'),
      count: db.prepare('SELECT COUNT(*) AS cnt FROM interaction_events WHERE session_id = ?'),
    };
  }

  insert(event: Omit<InteractionEvent, 'id'>): void {
    this.stmts.insert.run(event);
  }

  getNextSequence(sessionId: string): number {
    const row = this.stmts.getNextSequence.get(sessionId) as { next_seq: number };
    return row.next_seq;
  }

  findBySession(sessionId: string, limit: number = 1000): InteractionEvent[] {
    return this.stmts.findBySession.all(sessionId, limit) as InteractionEvent[];
  }

  findBySessionAndType(sessionId: string, type: InteractionType): InteractionEvent[] {
    return this.stmts.findBySessionAndType.all(sessionId, type) as InteractionEvent[];
  }

  findById(id: number): InteractionEvent | null {
    return (this.stmts.findById.get(id) as InteractionEvent) ?? null;
  }

  deleteBySession(sessionId: string): void {
    this.stmts.deleteBySession.run(sessionId);
  }

  count(sessionId: string): number {
    const row = this.stmts.count.get(sessionId) as { cnt: number };
    return row.cnt;
  }
}
