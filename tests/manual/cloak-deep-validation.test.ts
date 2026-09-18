/**
 * Opt-in, single-seat validation. Run ONLY after checking the local runtime/seats:
 *   $env:AA_REAL_CLOAK="1"
 *   node scripts/run-electron-vitest.mjs tests/manual/cloak-deep-validation.test.ts
 * AA_CLOAK_ITERATIONS accepts 1-100 and defaults to 30. Build preload assets first.
 * AA_CLOAK_ALLOW_KNOWN_GAPS=1 runs the rest of the matrix when a real Cloak
 * build cannot prove SharedWorker first-script coverage; it records the gap
 * as degraded instead of claiming that coverage succeeded.
 * SQLite must load with Electron's ABI; an opted-in native-module failure is fatal.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { BrowserContext as NativeContext, CDPSession, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isReady: () => true,
  },
}));

import { CloakBrowserBackend } from "../../src/main/browser/cloak-backend";
import type { BrowserContext, BrowserTarget } from "../../src/main/browser/contracts";
import { CaptureEngine } from "../../src/main/capture/capture-engine";
import { DeepCaptureController } from "../../src/main/capture/deep-capture-controller";
import { CdpManager } from "../../src/main/cdp/cdp-manager";
import { CaptureReliabilityRepo } from "../../src/main/db/capture-reliability-repo";
import { runMigrations } from "../../src/main/db/migrations";
import {
  JsHooksRepo,
  RequestsRepo,
  StorageSnapshotsRepo,
} from "../../src/main/db/repositories";
import {
  CAPTURE_BRIDGE_NAME,
  CAPTURE_ENTRY_SCRIPT_FLAG,
  CAPTURE_PUSH_BINDING,
} from "../../src/shared/capture-protocol";
import type {
  CaptureAcceptedRecord,
  CaptureHealthSnapshot,
  CaptureRealmKind,
} from "../../src/shared/capture-protocol";
import type { CloakRuntimePolicy } from "../../src/shared/types";

const requireNative = createRequire(import.meta.url);
const outputDirectory = join(process.cwd(), "output", "playwright");
const reportPath = join(outputDirectory, "cloak-deep-validation.json");
const sessionId = "manual-cloak-deep-validation";

type ScenarioStatus = "pending" | "passed" | "degraded" | "failed";
interface ScenarioReport {
  name: string;
  assertions: string[];
  status: ScenarioStatus;
  counts?: Record<string, number>;
}

/**
 * Read — never write — the realm's capture state at the instant a fixture runs.
 * A realm can report healthy to the host and still be the wrong realm, or carry
 * a run label the host has already sealed; only the fixture itself can say which.
 */
const WITNESS_SOURCE = `
  const witnessCapture = () => {
    try {
      const bridge = globalThis[${JSON.stringify(CAPTURE_BRIDGE_NAME)}];
      const status = bridge && bridge.snapshot ? bridge.snapshot().status : null;
      const isNative = (fn) => {
        try { return /\\[native code\\]/.test(Function.prototype.toString.call(fn)); }
        catch (error) { return null; }
      };
      return JSON.stringify({
        bridge: typeof bridge,
        runId: bridge ? String(bridge.runId) : null,
        recording: bridge ? bridge.recording : null,
        entryScript: globalThis[${JSON.stringify(CAPTURE_ENTRY_SCRIPT_FLAG)}] === true,
        push: typeof globalThis[${JSON.stringify(CAPTURE_PUSH_BINDING)}],
        seq: status ? status.generatedSequence : null,
        pending: status ? status.pendingEvents : null,
        dropped: status ? status.droppedEvents : null,
        atobNative: isNative(globalThis.atob),
        fetchNative: isNative(globalThis.fetch),
        atobHook: status ? status.installed.atob : null,
        fetchHook: status ? status.installed.fetch : null,
      });
    } catch (error) {
      return JSON.stringify({ error: String(error) });
    }
  };
`;

interface ManifestEntry {
  marker: string;
  encodedMarker: string;
  apiUrl: string;
  observationUrl: string;
  realmKind: CaptureRealmKind;
  runId: string | null;
  executions: number;
  apiRequests: number;
  observations: number;
  /** What the realm's capture bridge looked like at the instant the fixture ran. */
  witnesses: string[];
}

interface HookRow {
  id: number;
  run_id: string;
  realm_id: string;
  producer_sequence: number;
  function_name: string;
  arguments: string;
}

interface WorkerVersion {
  versionId: string;
  scriptURL: string;
  runningStatus: string;
  status: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withFixtureDeadline<Value>(
  operation: Promise<Value>,
  description: string,
  timeoutMilliseconds = 20_000,
): Promise<Value> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeoutMilliseconds);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function waitUntil<Value>(
  readValue: () => Value | Promise<Value>,
  matches: (value: Value) => boolean,
  description: string,
  timeoutMilliseconds = 20_000,
): Promise<Value> {
  const deadline = Date.now() + timeoutMilliseconds;
  do {
    const value = await readValue();
    if (matches(value)) return value;
    await delay(50);
  } while (Date.now() < deadline);
  // Never serialize an evaluation result, DB row, or backend error into diagnostics.
  throw new Error(`Timed out: ${description}`);
}

function readIterationCount(): number {
  const iterationCount = Number(process.env.AA_CLOAK_ITERATIONS ?? "30");
  if (!Number.isSafeInteger(iterationCount) || iterationCount < 1 || iterationCount > 100) {
    throw new Error("AA_CLOAK_ITERATIONS must be an integer between 1 and 100");
  }
  return iterationCount;
}

function readRuntimePolicy(): CloakRuntimePolicy {
  const policy = process.env.AA_CLOAK_POLICY ?? "strict";
  if (policy !== "strict" && policy !== "free-latest") {
    throw new Error("AA_CLOAK_POLICY must be strict or free-latest");
  }
  return policy;
}

function createScenarios(): ScenarioReport[] {
  return [
    {
      name: "earliest-inline-and-network-persistence",
      assertions: ["First inline atob and fetch are in js_hooks", "Actual response body and saved status are in requests", "Programmatic click is durably recorded exactly once"],
      status: "pending",
    },
    {
      name: "continuous-cross-site-navigation",
      assertions: ["Configured navigations alternate 127.0.0.1 and localhost", "Every manifest operation has exact DB counts, without waiting on capture callbacks between navigations"],
      status: "pending",
    },
    {
      name: "dedicated-classic-module-and-shared-workers",
      assertions: ["Classic, module, and shared worker first-script operations execute", "Exact hooks have correct worker realm attribution and early injection"],
      status: "pending",
    },
    {
      name: "service-worker-install-fetch-message-restart",
      assertions: ["Startup, install, intercepted fetch, and synthetic message operations are captured", "Public CDP stops the real worker and a message restarts it", "Two startup executions have exact counts, not duplicate delivery"],
      status: "pending",
    },
    {
      name: "dynamic-cross-site-iframe-and-popup",
      assertions: ["Dynamic cross-site iframe and popup first scripts execute", "Exact document hooks are captured before attaching any test bindings"],
      status: "pending",
    },
    {
      name: "fast-close-honest-coverage",
      assertions: ["Programmatic atob/fetch execution is independently confirmed before closing", "No duplicate hooks", "Missing tail events require a new durable unknown-coverage gap, never a fabricated zero-loss claim"],
      status: "pending",
    },
    {
      name: "stop-and-cross-run-isolation",
      assertions: ["Stop seals the old run before closing its browser", "Stopped callbacks and old DB rows remain unchanged", "Delayed old fetch results never become new-run rows", "Operations between runs are not recorded"],
      status: "pending",
    },
    {
      name: "warm-existing-service-worker",
      assertions: ["Service worker executes before the new controller starts", "Existing worker is explicitly late-attached with a durable unknown-coverage gap", "Post-attachment message operations have exact DB counts"],
      status: "pending",
    },
    {
      name: "sqlite-reopen-durability",
      assertions: ["Both runs are stopped and SQLite integrity_check is ok", "Reopened DB retains hook counts, request body status, receipts, and coverage history"],
      status: "pending",
    },
  ];
}

/** The fixture server and manifest, not recordCb/healthCb, are the operation oracle. */
class LocalFixtures {
  readonly manifest: ManifestEntry[] = [];
  /**
   * An inert same-origin document. Scenarios that only need a real page on the
   * fixture origin must not navigate to a missing path: Chromium fails a
   * main-frame navigation to a bodyless 404 outright with
   * ERR_HTTP_RESPONSE_CODE_FAILURE, so the page would never commit and the
   * scenario would measure about:blank instead.
   */
  readonly blankDocumentPath = "/document/blank";
  readonly documents = new Map<string, string>([
    ["/document/blank", "<!doctype html><html><head><title>Blank fixture</title></head><body></body></html>"]
  ]);
  readonly scripts = new Map<string, string>();
  readonly servers: Server[] = [];
  readonly responseTimers = new Set<ReturnType<typeof setTimeout>>();
  readonly heldResponses = new Map<string, () => void>();
  readonly prefix = randomUUID().replaceAll("-", "");
  primaryOrigin = "";
  secondaryOrigin = "";

  async start(): Promise<void> {
    // Bind localhost separately so IPv4/IPv6 resolver preferences cannot break site B.
    this.primaryOrigin = await this.listen("127.0.0.1");
    this.secondaryOrigin = await this.listen("localhost");
  }

  createEntry(
    label: string,
    runId: string | null,
    realmKind: CaptureRealmKind = "document",
    origin = this.primaryOrigin,
    responseDelayMilliseconds = 0,
  ): ManifestEntry {
    const marker = `aa-${this.prefix}-${label}`;
    const entry: ManifestEntry = {
      marker,
      encodedMarker: Buffer.from(marker).toString("base64"),
      apiUrl: `${origin}/api?marker=${marker}&delay=${responseDelayMilliseconds}`,
      observationUrl: `${origin}/observed?marker=${marker}`,
      realmKind,
      runId,
      executions: 1,
      apiRequests: 0,
      observations: 0,
      witnesses: [],
    };
    this.manifest.push(entry);
    return entry;
  }

  operation(entry: ManifestEntry): string {
    return `(() => {
      const decodedMarker = atob(${JSON.stringify(entry.encodedMarker)});
      if (decodedMarker !== ${JSON.stringify(entry.marker)}) throw new Error("Fixture decode failed");
      const apiPromise = fetch(${JSON.stringify(entry.apiUrl)}).then(response => response.json());
      const observationPromise = fetch(${JSON.stringify(entry.observationUrl)});
      return Promise.all([apiPromise, observationPromise]).then(([body]) => {
        if (body.fixture !== ${JSON.stringify(entry.marker)}) throw new Error("Fixture response failed");
        return true;
      });
    })()`;
  }

  document(entry: ManifestEntry, extraSource = ""): string {
    const path = `/document/${entry.marker}`;
    this.documents.set(path, `<!doctype html><html><head><script>
      globalThis.__fixtureDone = ${this.operation(entry)};
      ${extraSource}
    </script><title>Local capture validation</title></head><body>
      <button id="fixture-action">Synthetic action</button>
    </body></html>`);
    return `${new URL(entry.apiUrl).origin}${path}`;
  }

  script(label: string, source: string, origin = this.primaryOrigin): string {
    const path = `/script/${this.prefix}-${label}.js`;
    this.scripts.set(path, source);
    return `${origin}${path}`;
  }

  serviceWorker(label: string, boot: ManifestEntry, install?: ManifestEntry): string {
    return this.script(label, `
      const bootPromise = ${this.operation(boot)};
      ${WITNESS_SOURCE}
      const operate = (parameters) => {
        const witness = witnessCapture();
        const decodedMarker = atob(parameters.encodedMarker);
        if (decodedMarker !== parameters.marker) throw new Error("Synthetic parameters mismatch");
        const afterAtob = witnessCapture();
        return Promise.all([
          fetch(parameters.apiUrl).then(response => response.json()),
          fetch(parameters.observationUrl + "&witness=" + encodeURIComponent(witness)
            + "&witnessAfterAtob=" + encodeURIComponent(afterAtob))
        ]).then(([body]) => {
          if (body.fixture !== parameters.marker) throw new Error("Synthetic response mismatch");
          return true;
        });
      };
      addEventListener("install", event => {
        event.waitUntil(Promise.all([bootPromise, ${install ? this.operation(install) : "Promise.resolve(true)"}])
          .then(() => self.skipWaiting()));
      });
      addEventListener("activate", event => event.waitUntil(self.clients.claim()));
      addEventListener("message", event => {
        event.waitUntil(Promise.all([bootPromise, operate(event.data)])
          .then(() => event.ports[0]?.postMessage({ done: true })));
      });
      addEventListener("fetch", event => {
        const requestUrl = new URL(event.request.url);
        if (requestUrl.pathname !== "/sw-synthetic") return;
        const parameters = JSON.parse(requestUrl.searchParams.get("parameters"));
        event.respondWith(operate(parameters).then(() => new Response(
          JSON.stringify({ synthetic: true }), { headers: { "content-type": "application/json" } }
        )));
      });
    `);
  }

  parameters(entry: ManifestEntry): Record<string, string> {
    return {
      marker: entry.marker,
      encodedMarker: entry.encodedMarker,
      apiUrl: entry.apiUrl,
      observationUrl: entry.observationUrl,
    };
  }

  releaseResponse(entry: ManifestEntry): void {
    const sendResponse = this.heldResponses.get(entry.marker);
    if (!sendResponse) throw new Error("Held fixture response unavailable");
    this.heldResponses.delete(entry.marker);
    sendResponse();
  }

  async close(): Promise<void> {
    for (const timer of this.responseTimers) clearTimeout(timer);
    this.responseTimers.clear();
    this.heldResponses.clear();
    await Promise.all(this.servers.map(async (server) => {
      if (!server.listening) return;
      const closing = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closing;
    }));
  }

  private async listen(hostname: string): Promise<string> {
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://fixture.invalid");
      response.setHeader("cache-control", "no-store");
      if (requestUrl.pathname === "/api" || requestUrl.pathname === "/observed") {
        const entry = this.manifest.find(candidate => candidate.marker === requestUrl.searchParams.get("marker"));
        if (!entry) {
          response.writeHead(404);
          response.end();
          return;
        }
        if (requestUrl.pathname === "/observed") {
          entry.observations += 1;
          const witness = requestUrl.searchParams.get("witness");
          const afterAtob = requestUrl.searchParams.get("witnessAfterAtob");
          if (witness) entry.witnesses.push(afterAtob ? `${witness} -> ${afterAtob}` : witness);
          response.writeHead(204);
          response.end();
          return;
        }
        entry.apiRequests += 1;
        const sendResponse = (): void => {
          if (response.destroyed) return;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ fixture: entry.marker }));
        };
        const responseDelay = Number(requestUrl.searchParams.get("delay"));
        if (responseDelay === -1) {
          this.heldResponses.set(entry.marker, sendResponse);
        } else if (responseDelay > 0) {
          const timer = setTimeout(() => {
            this.responseTimers.delete(timer);
            sendResponse();
          }, responseDelay);
          this.responseTimers.add(timer);
        } else sendResponse();
        return;
      }
      const documentSource = this.documents.get(requestUrl.pathname);
      const scriptSource = this.scripts.get(requestUrl.pathname);
      if (documentSource !== undefined || scriptSource !== undefined) {
        response.writeHead(200, {
          "content-type": documentSource !== undefined ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
          "service-worker-allowed": "/",
        });
        response.end(documentSource ?? scriptSource);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    this.servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, hostname, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server address unavailable");
    return `http://${hostname}:${address.port}`;
  }
}

function readHooks(database: Database.Database, runId: string): HookRow[] {
  return database.prepare(`
    SELECT id, run_id, realm_id, producer_sequence, function_name, arguments
    FROM js_hooks WHERE session_id = ? AND run_id = ? ORDER BY id
  `).all(sessionId, runId) as HookRow[];
}

function matchHooks(rows: HookRow[], entry: ManifestEntry, functionName: string): HookRow[] {
  return rows.filter(row => {
    if (row.function_name !== functionName) return false;
    const argumentsValue = JSON.parse(row.arguments) as { data?: string; url?: string };
    return functionName === "atob"
      ? argumentsValue.data === entry.encodedMarker
      : argumentsValue.url === entry.apiUrl;
  });
}

function countHooks(rows: HookRow[], entry: ManifestEntry): number[] {
  return ["atob", "window.fetch", "window.fetch.response"].map(functionName => matchHooks(rows, entry, functionName).length);
}

async function assertManifest(
  database: Database.Database,
  controller: DeepCaptureController,
  entries: ManifestEntry[],
): Promise<void> {
  try {
    await waitUntil(() => readHooks(database, controller.runId), rows => entries.every(entry =>
      countHooks(rows, entry).every(count => count >= entry.executions)), "manifest hooks committed");
  } catch (error) {
    const health = controller.getHealth();
    console.warn('[Real Cloak validation] Unmet synthetic manifest', JSON.stringify({
      operations: entries.map((entry, index) => {
        const allRows = readHooks(database, controller.runId);
        const byRealm = (functionName: string): Record<string, number[]> => {
          const grouped: Record<string, number[]> = {};
          for (const row of matchHooks(allRows, entry, functionName)) {
            (grouped[row.realm_id] ??= []).push(row.producer_sequence);
          }
          return grouped;
        };
        return { fixtureOrdinal: index, kind: entry.realmKind, marker: entry.marker,
          counts: countHooks(allRows, entry), executions: entry.observations,
          witnesses: entry.witnesses, controllerRunId: controller.runId,
          atobByRealm: byRealm("atob"), fetchByRealm: byRealm("window.fetch") };
      }),
      realms: health.realms.map(realm => ({ realmId: realm.realmId, kind: realm.kind, state: realm.state,
        earlyInjection: realm.earlyInjection, pendingEvents: realm.pendingEvents,
        installed: realm.installed, installedAtBootstrap: realm.installedAtBootstrap,
        droppedEvents: realm.droppedEvents, transport: realm.transport, reason: realm.reason })),
      gaps: health.gaps.map(gap => ({ reason: gap.reason, certainty: gap.certainty, realmId: gap.realmId })),
    }));
    throw error;
  }
  // Allow at least one poll to exercise push/poll receipt deduplication.
  await delay(900);
  const rows = readHooks(database, controller.runId);
  const realms = controller.getHealth().realms;
  for (const entry of entries) {
    expect(entry.observations, "independent atob execution beacon").toBe(entry.executions);
    expect(entry.apiRequests, "independent fixture API counter").toBe(entry.executions);
    expect(countHooks(rows, entry), "exact manifest hook counts").toEqual(Array(3).fill(entry.executions));
    for (const functionName of ["atob", "window.fetch", "window.fetch.response"]) {
      for (const row of matchHooks(rows, entry, functionName)) {
        expect(row.run_id).toBe(entry.runId);
        expect(row.producer_sequence).toBeGreaterThan(0);
        const realm = realms.find(candidate => candidate.realmId === row.realm_id);
        expect(realm?.kind, "backend-owned realm attribution").toBe(entry.realmKind);
        expect(realm?.installed.atob).toBe("installed");
        expect(realm?.installed.fetch).toBe("installed");
        if (entry.realmKind !== "document") {
          expect(realm?.installed["document.cookie.set"]).toBe("not-applicable");
        }
      }
    }
  }
}

async function assertWorkerManifestWithKnownSharedWorkerGap(
  database: Database.Database,
  controller: DeepCaptureController,
  entries: ManifestEntry[],
): Promise<boolean> {
  const dedicatedEntries = entries.filter(entry => entry.realmKind === "worker");
  const sharedEntries = entries.filter(entry => entry.realmKind === "shared_worker");
  await assertManifest(database, controller, dedicatedEntries);
  await delay(900);
  const rows = readHooks(database, controller.runId);
  const health = controller.getHealth();
  let degraded = false;
  for (const entry of sharedEntries) {
    expect(entry.observations, "independent shared-worker execution beacon").toBe(entry.executions);
    expect(entry.apiRequests, "independent shared-worker fixture API counter").toBe(entry.executions);
    const counts = countHooks(rows, entry);
    counts.forEach(count => expect(count, "shared-worker delivery never duplicates").toBeLessThanOrEqual(entry.executions));
    if (counts.some(count => count < entry.executions)) {
      degraded = true;
      const sharedRealmIds = new Set(health.realms
        .filter(realm => realm.kind === "shared_worker")
        .map(realm => realm.realmId));
      expect(health.gaps.some(gap => gap.certainty === "unknown-coverage" && gap.reason === "late-attachment"
        && gap.realmId !== null && sharedRealmIds.has(gap.realmId)),
      "missing SharedWorker startup events require a durable realm coverage gap").toBe(true);
      expect(controller.getHealth().workerCoverage).toBe("late-attachment");
    }
  }
  if (degraded) {
    // This opt-in mode validates the complete lifecycle matrix without turning
    // a known Cloak startup limitation into a false all-covered result.
    expect(process.env.AA_CLOAK_ALLOW_KNOWN_GAPS).toBe("1");
  } else {
    await assertManifest(database, controller, sharedEntries);
  }
  return degraded;
}

async function awaitFixture(page: Page): Promise<void> {
  const completed = await withFixtureDeadline(page.evaluate("globalThis.__fixtureDone"), "document fixture completed");
  expect(completed, "fixture independently completed").toBe(true);
}

async function sendWorkerMessage(page: Page, parameters: Record<string, string>): Promise<void> {
  expect(await withFixtureDeadline(page.evaluate(async (syntheticParameters) => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration?.active) throw new Error("Fixture service worker unavailable");
    return await new Promise<boolean>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => reject(new Error("Fixture worker message timed out")), 15_000);
      channel.port1.onmessage = event => {
        clearTimeout(timeout);
        channel.port1.close();
        resolve(event.data?.done === true);
      };
      registration.active!.postMessage(syntheticParameters, [channel.port2]);
    });
  }, parameters), "service worker message completed")).toBe(true);
}

function readRunState(database: Database.Database, runId: string): unknown {
  return database.prepare("SELECT state FROM capture_runs WHERE run_id = ?").get(runId);
}

function readDurableCounts(database: Database.Database): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const tableName of ["js_hooks", "requests", "interaction_events", "capture_runs", "capture_receipts", "capture_health"]) {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
    counts[tableName] = row.count;
  }
  return counts;
}

describe.skipIf(process.env.AA_REAL_CLOAK !== "1").sequential("real Cloak deep capture validation", () => {
  it("validates real realm coverage, exact durable delivery, and sealed capture epochs", async () => {
    const scenarios = createScenarios();
    const report: Record<string, unknown> = {
      startedAt: new Date().toISOString(),
      passed: false,
      scenarios,
      unsupportedTestGaps: [
        "No claim of lossless capture for a realm closed before its final acknowledgement; missing tails require durable unknown coverage.",
        "Warm service-worker startup/install work occurred before attachment and cannot be recovered retrospectively.",
        "Local HTTP fixtures only; no authentication, account pages, external sites, HTTPS/proxies, or credential-bearing payloads.",
        "SharedWorker module mode, browser crashes, process termination, BFCache, extension realms, and queue-exhaustion fault injection are not exercised.",
        "Network-body persistence is asserted for main-target CDP traffic; worker network-body persistence is not claimed.",
      ],
    };
    const fixtures = new LocalFixtures();
    let profileRoot: string | null = null;
    let database: Database.Database | null = null;
    let backend: CloakBrowserBackend | null = null;
    let controller: DeepCaptureController | null = null;
    let captureEngine: CaptureEngine | null = null;
    let networkCapture: CdpManager | null = null;
    let serviceWorkerSession: CDPSession | null = null;
    let activePhase = "setup";
    const cleanupFailures: string[] = [];
    const callbackCounts = new Map<string, number>();
    const healthCallbackCounts = new Map<string, number>();
    let reliabilityRepository: CaptureReliabilityRepo;
    let context: BrowserContext;
    let primaryTarget: BrowserTarget;
    let nativeContext: NativeContext;
    let primaryPage: Page;

    const scenario = async (
      name: string,
      validate: (result: ScenarioReport) => Promise<void>,
    ): Promise<void> => {
      const activeScenario = scenarios.find(candidate => candidate.name === name)!;
      activePhase = name;
      try {
        await validate(activeScenario);
        if (activeScenario.status !== "degraded") activeScenario.status = "passed";
      } catch (error) {
        activeScenario.status = "failed";
        throw error;
      }
    };

    await mkdir(outputDirectory, { recursive: true });
    // Overwrite any earlier successful report before native/runtime preparation can fail.
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    try {
      const iterations = readIterationCount();
      const policy = readRuntimePolicy();
      report.iterations = iterations;
      profileRoot = await mkdtemp(join(outputDirectory, "aa-cloak-deep-isolated-"));
      const databasePath = join(profileRoot, "capture.sqlite");
      const DatabaseConstructor = requireNative("better-sqlite3") as typeof Database;
      database = new DatabaseConstructor(databasePath);
      database.pragma("journal_mode = WAL");
      database.pragma("foreign_keys = ON");
      runMigrations(database);
      database.prepare("INSERT INTO sessions (id, name, status, created_at) VALUES (?, ?, 'running', ?)")
        .run(sessionId, "Synthetic local deep validation", Date.now());
      reliabilityRepository = new CaptureReliabilityRepo(database);
      captureEngine = new CaptureEngine(
        new RequestsRepo(database), new JsHooksRepo(database), new StorageSnapshotsRepo(database),
      );
      // Network rows go through the real engine; no fake renderer or duplicate hook insertions.
      captureEngine.start(sessionId, null as never);
      const bootstrapScripts = {
        hook: readFileSync(join(process.cwd(), "out-internal", "preload", "hook-script.js"), "utf8"),
        interaction: readFileSync(join(process.cwd(), "out-internal", "preload", "interaction-hook.js"), "utf8"),
      };
      await fixtures.start();
      backend = new CloakBrowserBackend({ policy, profileRoot });
      await backend.start();
      // Exactly one persistent context remains active through both sequential controller runs.
      context = await backend.openContext({
        sessionId,
        profileId: "deep-validation-profile",
        captureMode: "deep",
        backendOptions: { profileKey: "deep-validation-profile", cloakSeed: "73429" },
      });
      nativeContext = context.getNativeHandle<NativeContext>();
      [primaryTarget] = await context.targets();
      if (!primaryTarget) throw new Error("Cloak context has no initial target");
      primaryPage = primaryTarget.getNativeHandle<Page>();

      const startController = async (): Promise<DeepCaptureController> => {
        const nextController = new DeepCaptureController(
          context,
          reliabilityRepository,
          (record: CaptureAcceptedRecord) => {
            const recordRunId = record.record.run_id;
            if (typeof recordRunId === "string") {
              callbackCounts.set(recordRunId, (callbackCounts.get(recordRunId) ?? 0) + 1);
            }
          },
          (health: CaptureHealthSnapshot) => {
            if (health.runId) healthCallbackCounts.set(health.runId, (healthCallbackCounts.get(health.runId) ?? 0) + 1);
          },
          bootstrapScripts,
        );
        controller = nextController;
        const runtimeContext = backend!.getRuntime().getContext(sessionId);
        if (!runtimeContext) throw new Error("Cloak runtime profile unavailable");
        await nextController.start(runtimeContext.userDataDir);
        expect(nextController.getHealth().workerCoverage, "real worker-routing capability").not.toBe("unavailable");
        return nextController;
      };

      const firstController = await startController();
      networkCapture = new CdpManager();
      networkCapture.on("response-captured", response => captureEngine!.handleResponseCaptured(response));
      await networkCapture.start(primaryTarget, "deep");
      firstController.setNetworkState("running");
      const browserVersion = await networkCapture.sendCommand("Browser.getVersion");
      const runtimeStatus = backend.getRuntime().getStatus();
      const runtimeContext = backend.getRuntime().getContext(sessionId)!;
      report.runtime = {
        requestedPolicy: policy,
        resolvedPolicy: runtimeStatus.policy,
        configuredVersion: runtimeStatus.configuredVersion,
        resolvedVersion: runtimeStatus.actualVersion,
        contextVersion: runtimeContext.browserVersion,
        browserProduct: browserVersion.product,
        nodeVersion: process.versions.node,
        electronVersion: process.versions.electron ?? null,
        sqliteVersion: (database.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version,
        maxActiveContexts: 1,
        isolatedProfile: true,
      };
      expect(runtimeStatus.policy).toBe(policy);
      expect(runtimeContext.browserVersion).toBeTruthy();
      expect(browserVersion.product).toEqual(expect.any(String));

      const strictEntries: ManifestEntry[] = [];
      const earliestEntry = fixtures.createEntry("earliest-inline", firstController.runId);
      await scenario("earliest-inline-and-network-persistence", async result => {
        strictEntries.push(earliestEntry);
        await primaryTarget.navigate(fixtures.document(earliestEntry));
        await awaitFixture(primaryPage);
        await assertManifest(database!, firstController, [earliestEntry]);
        const responseRow = await waitUntil(() => database!.prepare(
          "SELECT status_code, response_body, body_status FROM requests WHERE session_id = ? AND url = ?",
        ).get(sessionId, earliestEntry.apiUrl) as { status_code: number; response_body: string; body_status: string } | undefined,
        row => row?.body_status === "saved", "real response persisted in requests");
        expect(responseRow).toMatchObject({ status_code: 200, body_status: "saved" });
        expect(JSON.parse(responseRow!.response_body)).toEqual({ fixture: earliestEntry.marker });
        const requestCount = database!.prepare("SELECT COUNT(*) AS count FROM requests WHERE url = ?")
          .get(earliestEntry.apiUrl) as { count: number };
        expect(requestCount.count).toBe(1);
        await primaryPage.locator("#fixture-action").click();
        const clickCount = await waitUntil(() => database!.prepare(`
          SELECT COUNT(*) AS count FROM interaction_events
          WHERE run_id = ? AND type = 'click' AND selector = '#fixture-action'
        `).get(firstController.runId) as { count: number },
        row => row.count >= 1, "real interaction committed");
        expect(clickCount.count).toBe(1);
        result.counts = { manifestOperations: 1, hookRows: 3, responseRows: 1, clickRows: 1 };
      });

      await scenario("continuous-cross-site-navigation", async result => {
        const navigationEntries: ManifestEntry[] = [];
        for (let iteration = 0; iteration < iterations; iteration += 1) {
          const origin = iteration % 2 === 0 ? fixtures.secondaryOrigin : fixtures.primaryOrigin;
          const entry = fixtures.createEntry(`navigation-${iteration}`, firstController.runId, "document", origin);
          navigationEntries.push(entry);
          await primaryTarget.navigate(fixtures.document(entry));
          await awaitFixture(primaryPage);
          // No capture binding calls, health waits, or per-navigation DB waits here.
        }
        strictEntries.push(...navigationEntries);
        await assertManifest(database!, firstController, navigationEntries);
        result.counts = { iterations, manifestOperations: navigationEntries.length, hookRows: navigationEntries.length * 3 };
      });

      // Return to the registration origin; worker URLs must be same-origin with their owner.
      activePhase = "dedicated-classic-module-and-shared-workers";
      const workerOwner = fixtures.createEntry("worker-owner", firstController.runId);
      strictEntries.push(workerOwner);
      await primaryTarget.navigate(fixtures.document(workerOwner));
      await awaitFixture(primaryPage);

      await scenario("dedicated-classic-module-and-shared-workers", async result => {
        const workerEntries: ManifestEntry[] = [];
        for (const workerType of ["classic", "module"] as const) {
          const entry = fixtures.createEntry(`dedicated-${workerType}`, firstController.runId, "worker");
          workerEntries.push(entry);
          const scriptUrl = fixtures.script(`dedicated-${workerType}`, `
            const bootPromise = ${fixtures.operation(entry)};
            bootPromise.then(() => self.postMessage({ done: true }));
          `);
          expect(await withFixtureDeadline(primaryPage.evaluate(async ({ url, type }) => {
            const globals = globalThis as typeof globalThis & { __fixtureWorkers?: Worker[] };
            const worker = new Worker(url, { type });
            (globals.__fixtureWorkers ??= []).push(worker);
            return await new Promise<boolean>((resolve, reject) => {
              worker.onmessage = event => resolve(event.data?.done === true);
              worker.onerror = () => reject(new Error("Dedicated fixture failed"));
            });
          }, { url: scriptUrl, type: workerType }), `${workerType} worker startup completed`)).toBe(true);
        }
        const sharedEntry = fixtures.createEntry("shared-worker", firstController.runId, "shared_worker");
        workerEntries.push(sharedEntry);
        const sharedScript = fixtures.script("shared-worker", `
          const bootPromise = ${fixtures.operation(sharedEntry)};
          const retainedPorts = [];
          self.onconnect = event => {
            const port = event.ports[0];
            retainedPorts.push(port);
            port.start();
            bootPromise.then(() => port.postMessage({ done: true }));
          };
        `);
        expect(await withFixtureDeadline(primaryPage.evaluate(async (url) => {
          const globals = globalThis as typeof globalThis & { __fixtureSharedWorker?: SharedWorker };
          const worker = new SharedWorker(url, { name: "synthetic-capture-validation" });
          globals.__fixtureSharedWorker = worker;
          worker.port.start();
          return await new Promise<boolean>((resolve, reject) => {
            worker.port.onmessage = event => resolve(event.data?.done === true);
            worker.onerror = () => reject(new Error("Shared fixture failed"));
          });
        }, sharedScript), "shared worker startup completed")).toBe(true);
        strictEntries.push(...workerEntries);
        const workerCoverageDegraded = process.env.AA_CLOAK_ALLOW_KNOWN_GAPS === "1"
          ? await assertWorkerManifestWithKnownSharedWorkerGap(database!, firstController, workerEntries)
          : (await assertManifest(database!, firstController, workerEntries), false);
        if (workerCoverageDegraded) result.status = "degraded";
        for (const entry of workerEntries.filter(candidate => candidate.realmKind === "worker")) {
          const hook = matchHooks(readHooks(database!, firstController.runId), entry, "atob")[0];
          expect(firstController.getHealth().realms.find(realm => realm.realmId === hook.realm_id)?.earlyInjection).toBe(true);
        }
        result.counts = { dedicatedClassic: 1, dedicatedModule: 1, sharedWorker: 1, hookRows: workerCoverageDegraded ? 6 : 9 };
      });

      const workerVersions = new Map<string, WorkerVersion>();
      await scenario("service-worker-install-fetch-message-restart", async result => {
        serviceWorkerSession = await nativeContext.newCDPSession(primaryPage);
        serviceWorkerSession.on("ServiceWorker.workerVersionUpdated", (event: { versions: WorkerVersion[] }) => {
          for (const version of event.versions) workerVersions.set(version.versionId, version);
        });
        await serviceWorkerSession.send("ServiceWorker.enable");
        const bootEntry = fixtures.createEntry("service-boot", firstController.runId, "service_worker");
        const installEntry = fixtures.createEntry("service-install", firstController.runId, "service_worker");
        const fetchEntry = fixtures.createEntry("service-fetch", firstController.runId, "service_worker");
        const messageEntry = fixtures.createEntry("service-message", firstController.runId, "service_worker");
        const restartEntry = fixtures.createEntry("service-restart-message", firstController.runId, "service_worker");
        const scriptUrl = fixtures.serviceWorker("service-cold", bootEntry, installEntry);
        expect(await withFixtureDeadline(primaryPage.evaluate(async (url) => {
          await navigator.serviceWorker.register(url, { scope: "/" });
          await navigator.serviceWorker.ready;
          if (!navigator.serviceWorker.controller) {
            await new Promise<void>(resolve => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
          }
          return true;
        }, scriptUrl), "cold service worker registration completed")).toBe(true);
        const workerVersion = await waitUntil(() => [...workerVersions.values()].find(version =>
          version.scriptURL === scriptUrl && version.status === "activated" && version.runningStatus === "running"),
        version => Boolean(version), "service worker activated and running");
        const interceptedUrl = `${fixtures.primaryOrigin}/sw-synthetic?parameters=${encodeURIComponent(JSON.stringify(fixtures.parameters(fetchEntry)))}`;
        expect(await withFixtureDeadline(
          primaryPage.evaluate(async (url) => (await fetch(url)).json(), interceptedUrl),
          "service worker intercepted fetch completed",
        )).toEqual({ synthetic: true });
        await sendWorkerMessage(primaryPage, fixtures.parameters(messageEntry));
        await assertManifest(database!, firstController, [bootEntry, installEntry, fetchEntry, messageEntry]);
        await serviceWorkerSession.send("ServiceWorker.stopWorker", { versionId: workerVersion!.versionId });
        await waitUntil(() => workerVersions.get(workerVersion!.versionId)?.runningStatus,
          status => status === "stopped", "service worker really stopped");
        bootEntry.executions = 2;
        await sendWorkerMessage(primaryPage, fixtures.parameters(restartEntry));
        const serviceEntries = [bootEntry, installEntry, fetchEntry, messageEntry, restartEntry];
        strictEntries.push(...serviceEntries);
        await assertManifest(database!, firstController, serviceEntries);
        const bootRealms = new Set(matchHooks(readHooks(database!, firstController.runId), bootEntry, "atob").map(row => row.realm_id));
        expect(bootRealms.size, "restart creates a new producer realm").toBe(2);
        for (const realmId of bootRealms) {
          expect(firstController.getHealth().realms.find(realm => realm.realmId === realmId)?.earlyInjection).toBe(true);
        }
        result.counts = { startupExecutions: 2, installs: 1, interceptedFetches: 1, messages: 2, hookRows: 18 };
      });

      await scenario("dynamic-cross-site-iframe-and-popup", async result => {
        const frameEntry = fixtures.createEntry("dynamic-frame", firstController.runId, "document", fixtures.secondaryOrigin);
        const popupEntry = fixtures.createEntry("popup-first-script", firstController.runId, "document", fixtures.secondaryOrigin);
        const frameUrl = fixtures.document(frameEntry);
        await primaryPage.evaluate(url => {
          const iframe = document.createElement("iframe");
          iframe.src = url;
          iframe.id = "cross-site-fixture";
          document.body.append(iframe);
        }, frameUrl);
        const frame = await waitUntil(() => primaryPage.frames().find(candidate => candidate.url() === frameUrl),
          candidate => Boolean(candidate), "dynamic cross-site frame committed");
        expect(await withFixtureDeadline(frame!.evaluate("globalThis.__fixtureDone"), "cross-site frame fixture completed")).toBe(true);
        const popupPromise = primaryPage.waitForEvent("popup", { timeout: 20_000 });
        await primaryPage.evaluate(url => { window.open(url, "_blank"); }, fixtures.document(popupEntry));
        const popupPage = await popupPromise;
        await popupPage.waitForLoadState("load");
        await awaitFixture(popupPage);
        strictEntries.push(frameEntry, popupEntry);
        await assertManifest(database!, firstController, [frameEntry, popupEntry]);
        for (const entry of [frameEntry, popupEntry]) {
          const hook = matchHooks(readHooks(database!, firstController.runId), entry, "atob")[0];
          expect(firstController.getHealth().realms.find(realm => realm.realmId === hook.realm_id)?.earlyInjection).toBe(true);
        }
        await popupPage.close();
        result.counts = { crossSiteFrames: 1, popups: 1, hookRows: 6 };
      });

      await scenario("fast-close-honest-coverage", async result => {
        const gapStart = Date.now();
        const fastEntries: ManifestEntry[] = [];
        const rawTargetIds = new Map<string, string>();
        for (let closeIteration = 0; closeIteration < 3; closeIteration += 1) {
          const fastEntry = fixtures.createEntry(`fast-close-${closeIteration}`, firstController.runId);
          fastEntries.push(fastEntry);
          const fastTarget = await context.createTarget();
          const fastPage = fastTarget.getNativeHandle<Page>();
          await fastPage.goto(fixtures.primaryOrigin + fixtures.blankDocumentPath);
          const identitySession = await nativeContext.newCDPSession(fastPage);
          try {
            const { targetInfo } = await identitySession.send("Target.getTargetInfo");
            rawTargetIds.set(fastEntry.marker, targetInfo.targetId);
          } finally {
            await identitySession.detach();
          }
          // Evaluation's return independently proves both calls happened; response delivery may be lost.
          expect(await fastPage.evaluate(({ encodedMarker, apiUrl }) => {
            atob(encodedMarker);
            void fetch(apiUrl).catch(() => undefined);
            return { atobCalls: 1, fetchCalls: 1 };
          }, fixtures.parameters(fastEntry))).toEqual({ atobCalls: 1, fetchCalls: 1 });
          await fastTarget.close();
        }
        await delay(1_500);
        const rows = readHooks(database!, firstController.runId);
        const persistedHealth = reliabilityRepository.getHealth(sessionId);
        const unknownGaps = persistedHealth.gaps.filter(gap => gap.runId === firstController.runId
          && gap.certainty === "unknown-coverage" && gap.startedAt >= gapStart);
        const missingEvents = fastEntries.reduce((total, entry) => {
          const counts = countHooks(rows, entry);
          counts.forEach(count => expect(count, "fast close must not duplicate delivery").toBeLessThanOrEqual(1));
          const missingCount = counts.filter(count => count === 0).length;
          if (missingCount > 0) {
            const targetRealmIds = new Set(persistedHealth.realms.filter(realm =>
              realm.targetId === rawTargetIds.get(entry.marker)).map(realm => realm.realmId));
            expect(unknownGaps.some(gap => gap.realmId !== null && targetRealmIds.has(gap.realmId)),
              "each missing tail requires its own durable realm coverage gap").toBe(true);
          }
          return total + missingCount;
        }, 0);
        result.counts = { closedTargets: 3, missingEvents, durableUnknownGaps: unknownGaps.length };
      });

      activePhase = "final-first-run-manifest";
      // A service worker may be stopped and restarted by the browser at any
      // time, and every start re-runs its entry script. The scenario that owns
      // each service-worker entry already asserted its exact execution count at
      // the moment it controlled the lifecycle; re-asserting that frozen number
      // here would be predicting the browser's idle policy, not the capture
      // layer. Re-anchor to the independent beacon so this pass still proves
      // the property that matters: captured hooks equal observed executions,
      // exactly, with no duplicates and nothing lost.
      for (const entry of strictEntries) {
        if (entry.realmKind === "service_worker") entry.executions = entry.observations;
      }
      // A service worker instance that started from its script cache never ran
      // the rewritten bytes, so its first statements are genuinely uncaptured.
      // The contract is not that this cannot happen — it is that it can never
      // happen silently: hold such an entry to the same rule the shared-worker
      // path uses, a shortfall only where the realm declared a durable gap.
      const serviceWorkerGapRealms = new Set(firstController.getHealth().gaps
        .filter(gap => gap.certainty === "unknown-coverage" && gap.realmId !== null)
        .map(gap => gap.realmId));
      const uncoveredServiceRealms = new Set(firstController.getHealth().realms
        .filter(realm => realm.kind === "service_worker" && !realm.earlyInjection)
        .map(realm => realm.realmId));
      const declaredServiceWorkerGap = [...uncoveredServiceRealms].some(realmId =>
        serviceWorkerGapRealms.has(realmId)) ||
        firstController.getHealth().gaps.some(gap => gap.reason === "worker-entry-script-unrewritten");
      const strictlyCounted = strictEntries.filter(entry => entry.realmKind !== "service_worker"
        || uncoveredServiceRealms.size === 0);
      if (strictlyCounted.length !== strictEntries.length) {
        expect(declaredServiceWorkerGap,
          "an uninstrumented service-worker start requires a durable realm coverage gap").toBe(true);
        expect(firstController.getHealth().workerCoverage).toBe("late-attachment");
      }
      await assertManifest(database, firstController, strictlyCounted);
      activePhase = "stop-and-cross-run-isolation";
      // Hold the server response explicitly; wall-clock delays cannot prove an epoch boundary.
      const pendingEntry = fixtures.createEntry("old-run-delayed-response", firstController.runId, "document", fixtures.primaryOrigin, -1);
      const pendingTarget = await context.createTarget();
      const pendingPage = pendingTarget.getNativeHandle<Page>();
      await pendingPage.goto(fixtures.document(pendingEntry), { waitUntil: "domcontentloaded" });
      const pendingIdentitySession = await nativeContext.newCDPSession(pendingPage);
      let pendingRawTargetId: string;
      try {
        const { targetInfo } = await pendingIdentitySession.send("Target.getTargetInfo");
        pendingRawTargetId = targetInfo.targetId;
      } finally {
        await pendingIdentitySession.detach();
      }
      await waitUntil(() => readHooks(database!, firstController.runId), rows =>
        matchHooks(rows, pendingEntry, "atob").length === 1 && matchHooks(rows, pendingEntry, "window.fetch").length === 1,
      "old run delayed request invocation committed");
      await waitUntil(() => fixtures.heldResponses.has(pendingEntry.marker),
        isHeld => isHeld, "old response held before stop");

      let secondController: DeepCaptureController;
      let warmBootEntry: ManifestEntry;
      let warmScriptUrl: string;
      let warmRawTargetId: string;
      let stoppedRows: HookRow[];
      let stoppedRecordCallbacks: number;
      let stoppedHealthCallbacks: number;
      await scenario("stop-and-cross-run-isolation", async result => {
        await firstController.stop();
        controller = null;
        stoppedRows = readHooks(database!, firstController.runId);
        stoppedRecordCallbacks = callbackCounts.get(firstController.runId) ?? 0;
        stoppedHealthCallbacks = healthCallbackCounts.get(firstController.runId) ?? 0;
        expect(readRunState(database!, firstController.runId)).toEqual({ state: "stopped" });
        expect(firstController.getHealth().state).toBe("stopped");
        expect(reliabilityRepository.getHealth(sessionId).state).toBe("stopped");
        await networkCapture!.stop();
        networkCapture = null;

        const betweenRunsEntry = fixtures.createEntry("between-runs-unrecorded", null);
        await primaryTarget.navigate(fixtures.document(betweenRunsEntry));
        await awaitFixture(primaryPage);
        // Prepare a warm service worker while no controller is running, without consuming a second seat.
        warmBootEntry = fixtures.createEntry("warm-service-pre-attachment", null, "service_worker");
        warmScriptUrl = fixtures.serviceWorker("service-warm", warmBootEntry);
        await withFixtureDeadline(primaryPage.evaluate(async url => {
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map(registration => registration.unregister()));
          await navigator.serviceWorker.register(url, { scope: "/" });
          await navigator.serviceWorker.ready;
        }, warmScriptUrl), "warm service worker registration completed");
        await waitUntil(() => [...workerVersions.values()].find(version => version.scriptURL === warmScriptUrl
          && version.status === "activated" && version.runningStatus === "running"),
        version => Boolean(version), "warm service worker running before attachment");
        await waitUntil(() => warmBootEntry.observations, count => count === 1, "warm startup independently observed");
        const { targetInfos } = await serviceWorkerSession!.send("Target.getTargets");
        const warmTarget = targetInfos.find(target => target.type === "service_worker" && target.url === warmScriptUrl);
        if (!warmTarget) throw new Error("Warm service worker target identity unavailable");
        warmRawTargetId = warmTarget.targetId;

        secondController = await startController();
        expect(secondController.runId).not.toBe(firstController.runId);
        await waitUntil(() => secondController.getHealth().realms.some(realm =>
          realm.targetId === pendingRawTargetId && realm.runId === secondController.runId
          && realm.state === "healthy" && realm.installed.fetch === "installed"),
        isConfigured => isConfigured, "pending document configured for the new epoch");
        expect(fixtures.heldResponses.has(pendingEntry.marker)).toBe(true);
        fixtures.releaseResponse(pendingEntry);
        await awaitFixture(pendingPage);
        await delay(1_500);
        expect(readHooks(database!, firstController.runId)).toEqual(stoppedRows);
        expect(callbackCounts.get(firstController.runId) ?? 0).toBe(stoppedRecordCallbacks);
        expect(healthCallbackCounts.get(firstController.runId) ?? 0).toBe(stoppedHealthCallbacks);
        const newRows = readHooks(database!, secondController.runId);
        expect(countHooks(newRows, pendingEntry), "old pending results cannot cross capture epochs").toEqual([0, 0, 0]);
        expect(countHooks(newRows, betweenRunsEntry)).toEqual([0, 0, 0]);
        expect(countHooks(readHooks(database!, firstController.runId), betweenRunsEntry)).toEqual([0, 0, 0]);
        await pendingTarget.close();
        result.counts = { sequentialRuns: 2, lateOldRunWrites: 0, crossRunWrites: 0 };
      });

      await scenario("warm-existing-service-worker", async result => {
        const warmRealm = await waitUntil(() => secondController.getHealth().realms.find(realm =>
          realm.kind === "service_worker" && realm.targetId === warmRawTargetId && !realm.earlyInjection),
        realm => Boolean(realm), "explicit warm worker late attachment");
        const persistedHealth = reliabilityRepository.getHealth(sessionId);
        expect(persistedHealth.gaps.some(gap => gap.runId === secondController.runId
          && gap.realmId === warmRealm!.realmId && gap.certainty === "unknown-coverage" && gap.reason === "late-attachment")).toBe(true);
        expect(secondController.getHealth().workerCoverage).toBe("late-attachment");
        const warmMessageEntry = fixtures.createEntry("warm-service-message", secondController.runId, "service_worker");
        await sendWorkerMessage(primaryPage, fixtures.parameters(warmMessageEntry));
        await assertManifest(database!, secondController, [warmMessageEntry]);
        const secondRows = readHooks(database!, secondController.runId);
        expect(countHooks(secondRows, warmBootEntry), "warm startup is not retrospectively invented").toEqual([0, 0, 0]);
        expect(warmBootEntry.observations).toBe(1);
        result.counts = { preAttachmentExecutions: 1, lateAttachmentGaps: 1, postAttachmentHookRows: 3 };
      });

      await scenario("sqlite-reopen-durability", async result => {
        await secondController.stop();
        controller = null;
        expect(readRunState(database!, secondController.runId)).toEqual({ state: "stopped" });
        const finalHealth = reliabilityRepository.getHealth(sessionId);
        expect(finalHealth.state).toBe("stopped");
        expect(finalHealth.persistenceError).toBeNull();
        const finalCounts = readDurableCounts(database!);
        const firstRunRows = readHooks(database!, firstController.runId);
        const secondRunRows = readHooks(database!, secondController.runId);
        const requestBody = database!.prepare("SELECT response_body, body_status FROM requests WHERE url = ?").get(earliestEntry.apiUrl);
        const callbackCount = callbackCounts.get(secondController.runId) ?? 0;
        await delay(1_000);
        expect(callbackCounts.get(secondController.runId) ?? 0).toBe(callbackCount);
        expect(readDurableCounts(database!)).toEqual(finalCounts);
        await serviceWorkerSession!.detach();
        serviceWorkerSession = null;
        captureEngine!.stop();
        await backend!.closeContext(sessionId);
        expect(backend!.getContext(sessionId)).toBeNull();
        database!.close();
        database = new DatabaseConstructor(databasePath);
        database.pragma("foreign_keys = ON");
        expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
        expect(readDurableCounts(database)).toEqual(finalCounts);
        expect(readHooks(database, firstController.runId)).toEqual(firstRunRows);
        expect(readHooks(database, secondController.runId)).toEqual(secondRunRows);
        expect(database.prepare("SELECT response_body, body_status FROM requests WHERE url = ?").get(earliestEntry.apiUrl)).toEqual(requestBody);
        const reopenedRepository = new CaptureReliabilityRepo(database);
        expect(reopenedRepository.getHealth(sessionId)).toEqual(finalHealth);
        expect(readRunState(database, firstController.runId)).toEqual({ state: "stopped" });
        expect(readRunState(database, secondController.runId)).toEqual({ state: "stopped" });
        const duplicates = database.prepare(`
          SELECT COUNT(*) AS count FROM (
            SELECT run_id, realm_id, producer_sequence FROM js_hooks
            WHERE run_id IS NOT NULL GROUP BY run_id, realm_id, producer_sequence HAVING COUNT(*) > 1
          )
        `).get() as { count: number };
        expect(duplicates.count).toBe(0);
        const missingReceipts = database.prepare(`
          SELECT COUNT(*) AS count FROM js_hooks AS hook
          WHERE hook.run_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM capture_receipts AS receipt
            WHERE receipt.run_id = hook.run_id AND receipt.realm_id = hook.realm_id
              AND receipt.sequence = hook.producer_sequence
          )
        `).get() as { count: number };
        expect(missingReceipts.count, "business rows retain their durable delivery receipts").toBe(0);
        result.counts = { ...finalCounts, duplicateProducerSequences: 0, hookRowsWithoutReceipts: 0 };
        report.health = {
          state: finalHealth.state,
          workerCoverage: finalHealth.workerCoverage,
          realmCounts: Object.fromEntries((["document", "worker", "shared_worker", "service_worker"] as const)
            .map(kind => [kind, finalHealth.realms.filter(realm => realm.kind === kind).length])),
          gapCounts: Object.fromEntries((["known-loss", "unknown-coverage", "delivery-delay"] as const)
            .map(certainty => [certainty, finalHealth.gaps.filter(gap => gap.certainty === certainty).length])),
          persistenceError: finalHealth.persistenceError,
        };
      });
      const hasDegradedCoverage = scenarios.some(result => result.status === "degraded");
      const allowsKnownCoverageGaps = process.env.AA_CLOAK_ALLOW_KNOWN_GAPS === "1";
      expect(scenarios.every(result => result.status === "passed"
        || (allowsKnownCoverageGaps && result.status === "degraded"))).toBe(true);
      report.coverageComplete = !hasDegradedCoverage;
      report.degraded = hasDegradedCoverage;
      report.passed = true;
    } catch (error) {
      report.passed = false;
      const failedScenario = scenarios.find(result => result.name === activePhase);
      if (failedScenario) failedScenario.status = "failed";
      report.failure = { phase: activePhase, category: error instanceof Error ? error.name : "UnknownError" };
      if (controller) {
        const health = controller.getHealth();
        report.failureEvidence = {
          realms: health.realms.map(realm => ({
            kind: realm.kind,
            realmId: realm.realmId,
            targetId: realm.targetId,
            earlyInjection: realm.earlyInjection,
            state: realm.state,
            installed: realm.installed,
            pendingEvents: realm.pendingEvents,
            reason: realm.reason,
          })),
          gaps: health.gaps.map(gap => ({
            realmId: gap.realmId,
            reason: gap.reason,
            certainty: gap.certainty,
          })),
        };
      }
      throw error;
    } finally {
      // Stop producer/controller before releasing CDP, browser context, DB, or profile.
      const cleanup = async (label: string, operation: () => Promise<unknown> | unknown): Promise<void> => {
        try { await operation(); }
        catch { cleanupFailures.push(label); report.passed = false; }
      };
      await cleanup("controller-stop", () => controller?.stop());
      await cleanup("network-stop", () => networkCapture?.stop());
      await cleanup("service-worker-session-detach", () => serviceWorkerSession?.detach());
      await cleanup("capture-engine-stop", () => captureEngine?.stop());
      await cleanup("backend-shutdown", () => backend?.shutdown());
      await cleanup("fixture-servers-close", () => fixtures.close());
      await cleanup("database-close", () => { if (database?.open) database.close(); });
      await cleanup("isolated-profile-remove", () => profileRoot && rm(profileRoot, {
        recursive: true, force: true, maxRetries: 5, retryDelay: 200,
      }));
      report.finishedAt = new Date().toISOString();
      report.cleanupFailures = cleanupFailures;
      // Allowlisted summary only: no hook arguments/results, network bodies/headers, account diagnostics, or profile paths.
      await writeFile(reportPath, JSON.stringify(report, null, 2));
      if (cleanupFailures.length) throw new Error("Deep validation cleanup failed; inspect sanitized report");
    }
  }, 240_000 + Math.min(Number(process.env.AA_CLOAK_ITERATIONS) || 30, 100) * 5_000);
});
