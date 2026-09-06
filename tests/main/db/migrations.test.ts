import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  runMigrations,
  migrateAddStreamingAndWebSocketFlags,
  migrateAddBrowserPersistenceTables,
  migrateAddReportArtifactColumns,
} from "../../../src/main/db/migrations";
import {
  AnalysisReportsRepo,
  BrowserProfilesRepo,
  BrowserTabsRepo,
  SessionBrowserConfigRepo,
  SessionsRepo,
} from "../../../src/main/db/repositories";
import type {
  AnalysisReport,
  BrowserProfile,
  BrowserTabState,
  SessionBrowserConfig,
} from "../../../src/shared/types";
import path from "path";
import fs from "fs";
import os from "os";
import { createRequire } from "module";

type BetterSqlite3Module = typeof import("better-sqlite3");
type BetterSqlite3Database = import("better-sqlite3").Database;

const require = createRequire(import.meta.url);

let Database: BetterSqlite3Module | null = null;
let sqliteLoadError: Error | null = null;

try {
  Database = require("better-sqlite3") as BetterSqlite3Module;
  const probe = new Database(":memory:");
  probe.close();
} catch (error) {
  sqliteLoadError = error as Error;
  Database = null;
}

const describeDatabaseMigrations = sqliteLoadError ? describe.skip : describe;

describeDatabaseMigrations("Database Migrations", () => {
  let db: BetterSqlite3Database | null = null;
  let dbPath: string;

  beforeEach(() => {
    // Create a temporary database file for testing
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-db-"));
    dbPath = path.join(tmpDir, "test.db");
    db = new Database!(dbPath);
    db.pragma("foreign_keys = ON");

    // Run initial migrations to set up schema
    runMigrations(db);
  });

  afterEach(() => {
    // Clean up
    db?.close();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    const tmpDir = path.dirname(dbPath);
    if (fs.existsSync(tmpDir)) {
      fs.rmdirSync(tmpDir);
    }
  });

  it("应该成功添加 is_streaming 和 is_websocket 列到 requests 表", () => {
    // Check that columns exist after migration
    const tableInfo = db!.prepare("PRAGMA table_info(requests)").all() as any[];
    const columnNames = tableInfo.map((col: any) => col.name);

    expect(columnNames).toContain("is_streaming");
    expect(columnNames).toContain("is_websocket");
  });

  it("应该可以重复执行迁移而不抛出错误（幂等性）", () => {
    // First execution (already done in beforeEach via runMigrations)
    // Second execution should not throw
    expect(() => {
      migrateAddStreamingAndWebSocketFlags(db!);
    }).not.toThrow();

    // Third execution to ensure idempotency
    expect(() => {
      migrateAddStreamingAndWebSocketFlags(db!);
    }).not.toThrow();

    // Verify columns still exist and have correct defaults
    const tableInfo = db!.prepare("PRAGMA table_info(requests)").all() as any[];
    const isStreamingCol = tableInfo.find(
      (col: any) => col.name === "is_streaming",
    ) as any;
    const isWebsocketCol = tableInfo.find(
      (col: any) => col.name === "is_websocket",
    ) as any;

    expect(isStreamingCol).toBeDefined();
    expect(isWebsocketCol).toBeDefined();
    expect(isStreamingCol.dflt_value).toBe("0");
    expect(isWebsocketCol.dflt_value).toBe("0");
  });

  it("应该保持向后兼容性 - 现有数据应该继续有效", () => {
    // Insert a request without the new columns (simulating old data)
    const sessionId = "session-1";
    const requestId = "req-1";

    // First, create a session
    db!.prepare(
      `
      INSERT INTO sessions (id, name, created_at)
      VALUES (?, ?, ?)
    `,
    ).run(sessionId, "Test Session", Date.now());

    // Insert a request record
    db!.prepare(
      `
      INSERT INTO requests
      (id, session_id, sequence, timestamp, method, url)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run(requestId, sessionId, 1, Date.now(), "GET", "https://example.com");

    // Query the request back
    const request = db!
      .prepare("SELECT * FROM requests WHERE id = ?")
      .get(requestId) as any;

    // Verify the record exists and new columns have default values
    expect(request).toBeDefined();
    expect(request.id).toBe(requestId);
    expect(request.is_streaming).toBe(0);
    expect(request.is_websocket).toBe(0);
  });

  it("应该回填 Anthropic 缓存输入 token", () => {
    const sessionId = "session-anthropic-usage";
    db!.prepare(
      "INSERT INTO sessions (id, name, created_at) VALUES (?, ?, ?)",
    ).run(sessionId, "Anthropic Usage", Date.now());
    db!.prepare(`
      INSERT INTO ai_request_logs (
        session_id, report_id, type, provider, model,
        request_url, request_method, request_headers, request_body,
        status_code, response_headers, response_body,
        prompt_tokens, completion_tokens, duration_ms, error, created_at
      ) VALUES (?, NULL, ?, ?, ?, ?, 'POST', '{}', '{}', 200, '{}', ?, ?, ?, 10, NULL, ?)
    `).run(
      sessionId,
      "chat",
      "anthropic",
      "claude-sonnet-4.5",
      "https://api.anthropic.com/v1/messages",
      JSON.stringify({
        usage: {
          input_tokens: 351,
          cache_creation_input_tokens: 15_204,
          cache_read_input_tokens: 0,
          output_tokens: 1_335,
        },
      }),
      351,
      1_335,
      Date.now(),
    );

    runMigrations(db!);

    const log = db!
      .prepare("SELECT prompt_tokens, completion_tokens FROM ai_request_logs WHERE session_id = ?")
      .get(sessionId) as { prompt_tokens: number; completion_tokens: number };
    expect(log.prompt_tokens).toBe(15_555);
    expect(log.completion_tokens).toBe(1_335);
  });

  it("应该以幂等方式创建浏览器持久化表", () => {
    expect(() => migrateAddBrowserPersistenceTables(db!)).not.toThrow();
    expect(() => migrateAddBrowserPersistenceTables(db!)).not.toThrow();

    const tables = db!
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((row) => row.name);

    expect(tableNames).toContain("session_browser_config");
    expect(tableNames).toContain("browser_profiles");
    expect(tableNames).toContain("browser_tabs");

    const configColumns = db!
      .prepare("PRAGMA table_info(session_browser_config)")
      .all() as Array<{ name: string; dflt_value: string | null }>;
    expect(configColumns.find((column) => column.name === "browser_backend")?.dflt_value)
      .toBe("'electron'");
    expect(configColumns.find((column) => column.name === "capture_mode")?.dflt_value)
      .toBe("'deep'");
  });

  it("应该以幂等方式为 analysis_reports 添加结构化产物列，并支持写入 / 更新 Spec", () => {
    expect(() => migrateAddReportArtifactColumns(db!)).not.toThrow();
    expect(() => migrateAddReportArtifactColumns(db!)).not.toThrow();

    const columns = (db!.prepare("PRAGMA table_info(analysis_reports)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["purpose", "spec_json", "spec_error", "enrichment_json"]));

    db!.prepare("INSERT INTO sessions (id, name, created_at) VALUES (?, ?, ?)").run("s-spec", "Spec", Date.now());
    const repo = new AnalysisReportsRepo(db!);
    const report: AnalysisReport = {
      id: "r-spec",
      session_id: "s-spec",
      created_at: Date.now(),
      llm_provider: "openai",
      llm_model: "gpt-4o",
      prompt_tokens: 1,
      completion_tokens: 1,
      report_content: "# r",
      filter_prompt_tokens: null,
      filter_completion_tokens: null,
      purpose: "reverse-api",
      spec_json: null,
      spec_error: null,
      enrichment_json: JSON.stringify({ requestCount: 0 }),
    };
    repo.insert(report);
    expect(repo.findById("r-spec")).toMatchObject({ purpose: "reverse-api", spec_json: null, enrichment_json: '{"requestCount":0}' });

    repo.updateSpec("r-spec", null, "boom");
    expect(repo.findById("r-spec")).toMatchObject({ spec_json: null, spec_error: "boom" });
    repo.updateSpec("r-spec", '{"specVersion":1}', null);
    expect(repo.findById("r-spec")).toMatchObject({ spec_json: '{"specVersion":1}', spec_error: null });

    // 老代码路径：报告对象没有新字段时也能插入（列为 NULL）
    const legacy = { ...report, id: "r-legacy" } as Partial<AnalysisReport>;
    delete legacy.purpose;
    delete legacy.spec_json;
    delete legacy.spec_error;
    delete legacy.enrichment_json;
    expect(() => repo.insert(legacy as AnalysisReport)).not.toThrow();
    expect(repo.findById("r-legacy")).toMatchObject({ purpose: null, spec_json: null });
  });

  it("应该为没有浏览器配置的历史会话返回 electron/deep 默认值", () => {
    const now = Date.now();
    db!.prepare(
      "INSERT INTO sessions (id, name, target_url, status, created_at, stopped_at) VALUES (?, ?, ?, ?, ?, NULL)",
    ).run("legacy-session", "Legacy", "https://example.com", "stopped", now);

    const session = new SessionsRepo(db!).findById("legacy-session");

    expect(session).toMatchObject({
      id: "legacy-session",
      browser_backend: "electron",
      capture_mode: "deep",
      browser_profile_id: null,
      last_browser_version: null,
    });
  });

  it("应该持久化会话配置并通过 Session 公共字段返回", () => {
    const now = Date.now();
    const sessions = new SessionsRepo(db!);
    const profiles = new BrowserProfilesRepo(db!);
    const configs = new SessionBrowserConfigRepo(db!);

    sessions.insert({
      id: "cloak-session",
      name: "Cloak",
      target_url: "https://example.com",
      status: "stopped",
      created_at: now,
      stopped_at: null,
    });
    profiles.insert({
      id: "profile-1",
      display_name: "Cloak",
      profile_key: "profile_01HXYZ",
      cloak_seed: "0x123456789abcdef0",
      state: "attached",
      last_used_at: now,
      retained_at: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    });
    const config: SessionBrowserConfig = {
      session_id: "cloak-session",
      browser_backend: "cloak",
      capture_mode: "passive",
      profile_id: "profile-1",
      last_browser_version: "cloak-1.2.3",
      created_at: now,
      updated_at: now,
    };
    configs.upsert(config);

    expect(configs.findBySessionId("cloak-session")).toEqual(config);
    expect(sessions.findById("cloak-session")).toMatchObject({
      browser_backend: "cloak",
      capture_mode: "passive",
      browser_profile_id: "profile-1",
      last_browser_version: "cloak-1.2.3",
    });
  });

  it("应该跨会话、Profile 和配置仓储回滚事务", () => {
    const now = Date.now();
    const sessions = new SessionsRepo(db!);
    const profiles = new BrowserProfilesRepo(db!);
    const configs = new SessionBrowserConfigRepo(db!);

    expect(() =>
      sessions.transaction(() => {
        sessions.insert({
          id: "transaction-session",
          name: "Transaction",
          target_url: "https://example.com",
          status: "stopped",
          created_at: now,
          stopped_at: null,
        });
        profiles.insert({
          id: "transaction-profile",
          display_name: "Transaction",
          profile_key: "transaction-profile-key",
          cloak_seed: "1234",
          state: "attached",
          last_used_at: null,
          retained_at: null,
          last_error: null,
          created_at: now,
          updated_at: now,
        });
        configs.upsert({
          session_id: "transaction-session",
          browser_backend: "cloak",
          capture_mode: "passive",
          profile_id: "transaction-profile",
          last_browser_version: null,
          created_at: now,
          updated_at: now,
        });
        throw new Error("transaction failed");
      }),
    ).toThrow("transaction failed");

    expect(sessions.findById("transaction-session")).toBeUndefined();
    expect(profiles.findById("transaction-profile")).toBeNull();
    expect(configs.findBySessionId("transaction-session")).toBeNull();
  });

  it("应该在删除会话后保留 retained profile 及其标签页", () => {
    const now = Date.now();
    const sessions = new SessionsRepo(db!);
    const profiles = new BrowserProfilesRepo(db!);
    const configs = new SessionBrowserConfigRepo(db!);
    const tabs = new BrowserTabsRepo(db!);
    const profile: BrowserProfile = {
      id: "profile-retained",
      display_name: "Delete me",
      profile_key: "profile_01HRETAINED",
      cloak_seed: "18446744073709551615",
      state: "attached",
      last_used_at: now,
      retained_at: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    const tab: BrowserTabState = {
      id: "tab-1",
      profile_id: profile.id,
      url: "https://example.com/account",
      title: "Account",
      position: 0,
      active: true,
      updated_at: now,
    };

    sessions.insert({
      id: "session-to-delete",
      name: "Delete me",
      target_url: "https://example.com",
      status: "stopped",
      created_at: now,
      stopped_at: now,
    });
    profiles.insert(profile);
    configs.upsert({
      session_id: "session-to-delete",
      browser_backend: "cloak",
      capture_mode: "deep",
      profile_id: profile.id,
      last_browser_version: null,
      created_at: now,
      updated_at: now,
    });
    tabs.upsert(tab);
    profiles.updateState(profile.id, "retained", null, now + 1);

    sessions.delete("session-to-delete");

    expect(configs.findBySessionId("session-to-delete")).toBeNull();
    expect(profiles.findById(profile.id)).toMatchObject({
      id: profile.id,
      state: "retained",
      retained_at: now + 1,
      cloak_seed: "18446744073709551615",
    });
    expect(tabs.findByProfileId(profile.id)).toEqual([tab]);
  });

  it("应该支持 profile 状态和标签页 CRUD", () => {
    const profiles = new BrowserProfilesRepo(db!);
    const tabs = new BrowserTabsRepo(db!);
    const now = Date.now();
    const profile: BrowserProfile = {
      id: "profile-crud",
      display_name: "CRUD profile",
      profile_key: "profile_01HCRUD",
      cloak_seed: "seed-v1",
      state: "retained",
      last_used_at: null,
      retained_at: now,
      last_error: null,
      created_at: now,
      updated_at: now,
    };

    profiles.insert(profile);
    expect(profiles.findByProfileKey(profile.profile_key)).toEqual(profile);
    expect(profiles.findByState("retained")).toEqual([profile]);

    profiles.updateState(profile.id, "delete_failed", "provider timeout", now + 1);
    expect(profiles.findById(profile.id)).toMatchObject({
      state: "delete_failed",
      last_error: "provider timeout",
      updated_at: now + 1,
    });

    tabs.replaceForProfile(profile.id, [
      {
        id: "tab-b",
        profile_id: profile.id,
        url: "https://example.com/b",
        title: "B",
        position: 1,
        active: false,
        updated_at: now,
      },
      {
        id: "tab-a",
        profile_id: profile.id,
        url: "https://example.com/a",
        title: "A",
        position: 0,
        active: true,
        updated_at: now,
      },
    ]);
    expect(tabs.findByProfileId(profile.id).map((tab) => tab.id)).toEqual([
      "tab-a",
      "tab-b",
    ]);
    expect(tabs.findById(profile.id, "tab-a")?.active).toBe(true);

    tabs.setActive(profile.id, "tab-b", now + 2);
    expect(tabs.findById(profile.id, "tab-a")?.active).toBe(false);
    expect(tabs.findById(profile.id, "tab-b")?.active).toBe(true);

    tabs.delete(profile.id, "tab-a");
    expect(tabs.findById(profile.id, "tab-a")).toBeNull();

    profiles.delete(profile.id);
    expect(profiles.findById(profile.id)).toBeNull();
    expect(tabs.findByProfileId(profile.id)).toEqual([]);
  });

});

if (sqliteLoadError) {
  describe("Database Migrations environment", () => {
    it("应该在原生模块不可用时给出明确信号", () => {
      expect(sqliteLoadError?.message).toBeTruthy();
    });
  });
}
