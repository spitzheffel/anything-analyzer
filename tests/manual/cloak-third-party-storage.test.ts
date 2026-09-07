/**
 * 诊断：Cloak 浏览器里跨站 iframe 能否访问 sessionStorage / localStorage / cookie。
 * 背景：Stripe 的 HumanSecurity（PerimeterX）挑战 iframe 报
 *   SecurityError: Failed to read the 'sessionStorage' property from 'Window': Access is denied
 * 该错误是 Chromium 在"第三方存储被拦"时的原生报错。Cloak 二进制默认阻止第三方 Cookie，
 * 需要 --fingerprint-allow-3p-cookies（README "Additional Flags"）。这里用两个不同 site 的
 * 本地服务复现，验证 buildCloakLaunchOptions 带上该 flag 后跨站 iframe 能正常用存储：
 *   顶层 http://127.0.0.1:A  →  iframe http://localhost:B
 *
 *   $env:AA_REAL_CLOAK="1"; node scripts/run-electron-vitest.mjs tests/manual/cloak-third-party-storage.test.ts
 */
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isReady: () => true,
  },
}));

import { CloakBrowserBackend } from "../../src/main/browser/cloak-backend";

const outputDir = join(process.cwd(), "output", "playwright");
const reportPath = join(outputDir, "cloak-third-party-storage.json");

interface Probe {
  origin: string;
  topOrigin: string | null;
  sessionStorage: string;
  localStorage: string;
  cookieRead: string;
  indexedDB: string;
  hasStorageAccess: string | null;
}

interface ProbeResult {
  top: Probe | null;
  frame: Probe | null;
}

const PROBE_SCRIPT = `
  function attempt(fn) { try { return "ok:" + String(fn()); } catch (e) { return "error:" + (e && e.name) + ":" + (e && e.message); } }
  async function run() {
    const out = {
      origin: location.origin,
      topOrigin: (function () { try { return window.top.location.origin; } catch { return null; } })(),
      sessionStorage: attempt(() => { sessionStorage.setItem("aa", "1"); return sessionStorage.getItem("aa"); }),
      localStorage: attempt(() => { localStorage.setItem("aa", "1"); return localStorage.getItem("aa"); }),
      cookieRead: attempt(() => document.cookie),
      indexedDB: attempt(() => typeof indexedDB.open),
      hasStorageAccess: null,
    };
    try { out.hasStorageAccess = String(await document.hasStorageAccess()); } catch (e) { out.hasStorageAccess = "error:" + e.name; }
    return out;
  }
`;

function frameHtml(): string {
  return `<!doctype html><html><body><script>
    ${PROBE_SCRIPT}
    run().then((probe) => { parent.postMessage({ aaProbe: probe }, "*"); });
  </script></body></html>`;
}

function topHtml(frameOrigin: string): string {
  return `<!doctype html><html><body>
    <iframe id="f" src="${frameOrigin}/frame.html"></iframe>
    <script>
      ${PROBE_SCRIPT}
      globalThis.__aaProbe = { top: null, frame: null };
      run().then((probe) => { globalThis.__aaProbe.top = probe; });
      addEventListener("message", (event) => {
        if (event.data && event.data.aaProbe) globalThis.__aaProbe.frame = event.data.aaProbe;
      });
    </script>
  </body></html>`;
}

async function listen(server: Server, host: string): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://${host}:${address.port}`;
}

async function waitUntil<T>(read: () => Promise<T>, matches: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await read();
    if (matches(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  return last!;
}

describe.skipIf(process.env.AA_REAL_CLOAK !== "1")("Cloak third-party storage access", () => {
  let topServer: Server;
  let frameServer: Server;
  let topOrigin: string;
  let frameOrigin: string;
  let profileRoot: string;
  const report: Record<string, unknown> = { startedAt: new Date().toISOString() };

  beforeAll(async () => {
    await mkdir(outputDir, { recursive: true });
    profileRoot = await mkdtemp(join(outputDir, "aa-cloak-3p-storage-"));
    frameServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(frameHtml());
    });
    frameOrigin = await listen(frameServer, "localhost");
    topServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(topHtml(frameOrigin));
    });
    topOrigin = await listen(topServer, "127.0.0.1");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => topServer.close(() => resolve()));
    await new Promise<void>((resolve) => frameServer.close(() => resolve()));
    await rm(profileRoot, { recursive: true, force: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nreport: ${reportPath}\n${JSON.stringify(report, null, 2)}`);
  });

  it("lets a cross-site iframe use sessionStorage / localStorage under Passive and Deep capture", async () => {
    const backend = new CloakBrowserBackend({ policy: "strict", profileRoot });
    await backend.start();
    try {
      // 第三轮复用第一轮的 profile：flag 是按次启动生效的，已初始化过的 profile 重开也要通过
      const runs: Array<{ mode: "passive" | "deep"; profileKey: string; seed: string }> = [
        { mode: "passive", profileKey: "3p-profile-a", seed: "31001" },
        { mode: "deep", profileKey: "3p-profile-b", seed: "31002" },
        { mode: "passive", profileKey: "3p-profile-a", seed: "31001" },
      ];
      for (const [index, run] of runs.entries()) {
        const label = `${run.mode}-${index}`;
        const context = await backend.openContext({
          sessionId: label,
          profileId: `${run.profileKey}-id`,
          captureMode: run.mode,
          backendOptions: { profileKey: run.profileKey, cloakSeed: run.seed },
        });
        const [target] = await context.targets();
        if (run.mode === "deep") {
          // 模拟应用在 Deep 模式下会做的事：暴露绑定 + 注入初始化脚本
          await target.exposeBinding("__aaProbeBinding", () => {});
          await target.addInitScript(`globalThis.__aaDeepInit = true;`);
        }
        await target.navigate(`${topOrigin}/top`);
        const result = await waitUntil(
          () => target.evaluate<ProbeResult>("globalThis.__aaProbe"),
          (value) => Boolean(value?.top && value?.frame),
        );
        report[label] = result ?? null;
        console.log(`\n[${label}] frame sessionStorage: ${result?.frame?.sessionStorage}`);
        console.log(`[${label}] frame localStorage  : ${result?.frame?.localStorage}`);
        console.log(`[${label}] frame hasStorageAccess: ${result?.frame?.hasStorageAccess}`);
        await backend.closeContext(label);

        // waitUntil 超时会把最后一次读到的值原样返回，可能是 null 或缺 frame
        expect(result?.frame, `${label}: iframe probe never reported`).toBeTruthy();
        expect(result!.frame!.sessionStorage).toBe("ok:1");
        expect(result!.frame!.localStorage).toBe("ok:1");
        expect(result!.frame!.hasStorageAccess).toBe("true");
      }
    } finally {
      await backend.shutdown();
    }
  }, 240_000);
});
