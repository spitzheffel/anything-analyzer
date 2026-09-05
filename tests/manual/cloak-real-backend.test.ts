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
import { CdpManager } from "../../src/main/cdp/cdp-manager";

const outputDir = join(process.cwd(), "output", "playwright");
const reportPath = join(outputDir, "cloak-real-backend.json");
const passiveScreenshotPath = join(outputDir, "cloak-real-backend-passive.png");
const deepScreenshotPath = join(outputDir, "cloak-real-backend-deep.png");

async function waitUntil<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await read();
    if (matches(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`Condition was not met; last value: ${JSON.stringify(last!)}`);
}

describe.skipIf(process.env.AA_REAL_CLOAK !== "1")(
  "real CloakBrowser backend",
  () => {
  let server: Server;
  let origin: string;
  let profileRoot: string;
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    passed: false,
  };

  beforeAll(async () => {
    await mkdir(outputDir, { recursive: true });
    profileRoot = await mkdtemp(join(outputDir, "aa-cloak-backend-smoke-"));
    server = createServer((request, response) => {
      if (request.url === "/api/data") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "backend-cdp-body-ok" }));
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html><head><title>AA Cloak Backend Fixture</title></head>
        <body>
          <button id="action">Action</button>
          <div id="result">loading</div>
          <script>
            globalThis.__fixtureState = { fetchResult: null };
            localStorage.setItem("aa-cloak-backend", "persisted");
            fetch("/api/data").then((response) => response.json()).then((value) => {
              globalThis.__fixtureState.fetchResult = value;
              document.querySelector("#result").textContent = value.message;
            });
          </script>
        </body></html>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profileRoot, { recursive: true, force: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2));
  });

  it(
    "captures Passive traffic and preserves Deep bindings across navigation",
    async () => {
      const backend = new CloakBrowserBackend({
        policy: "strict",
        profileRoot,
      });
      let deepCapture: CdpManager | null = null;
      await backend.start();

      try {
        const passiveContext = await backend.openContext({
          sessionId: "real-passive",
          profileId: "real-passive-profile",
          captureMode: "passive",
          backendOptions: {
            profileKey: "real-passive-profile",
            cloakSeed: "73191",
          },
        });
        const [passiveTarget] = await passiveContext.targets();
        const passiveTransport = await passiveTarget.getCdpTransport();
        const passiveLease = await passiveTransport.acquire("real-smoke-capture");
        await passiveLease.send("Network.enable");
        let apiRequestId: string | null = null;
        passiveLease.onMessage((message) => {
          if (
            message.method === "Network.responseReceived" &&
            (message.params.response as { url?: string } | undefined)?.url ===
              `${origin}/api/data`
          ) {
            apiRequestId = message.params.requestId as string;
          }
        });

        await passiveTarget.navigate(`${origin}/passive`);
        const passiveState = await waitUntil(
          () =>
            passiveTarget.evaluate<{
              fetchResult: { message: string } | null;
              fetchSource: string;
              hookType: string;
            }>(`({
              fetchResult: globalThis.__fixtureState?.fetchResult ?? null,
              fetchSource: Function.prototype.toString.call(globalThis.fetch),
              hookType: typeof globalThis.__aaSmokeBinding
            })`),
          (state) => state.fetchResult?.message === "backend-cdp-body-ok",
        );
        await waitUntil(
          async () => apiRequestId,
          (requestId) => typeof requestId === "string",
        );
        const body = await passiveLease.send<{ body: string }>(
          "Network.getResponseBody",
          { requestId: apiRequestId! },
        );
        const version = await passiveLease.send<{
          product: string;
          userAgent: string;
        }>("Browser.getVersion");
        await writeFile(passiveScreenshotPath, await passiveTarget.captureScreenshot());
        await passiveLease.release();
        report.passive = {
          browserVersion: version.product,
          userAgent: version.userAgent,
          responseBody: JSON.parse(body.body),
          fetchLooksNative: passiveState.fetchSource.includes("[native code]"),
          bindingAbsent: passiveState.hookType === "undefined",
        };
        expect(report.passive).toMatchObject({
          responseBody: { message: "backend-cdp-body-ok" },
          fetchLooksNative: true,
          bindingAbsent: true,
        });
        expect(version.product).toContain("151.0.7922.108");

        // Quick diagnostics do not expose a seat count for the current local
        // license. Release Passive before opening Deep so this backend test is
        // valid on the observed single-session plan as well as larger plans.
        await backend.closeContext("real-passive");
        expect(backend.getContext("real-passive")).toBeNull();

        const deepContext = await backend.openContext({
          sessionId: "real-deep",
          profileId: "real-deep-profile",
          captureMode: "deep",
          backendOptions: {
            profileKey: "real-deep-profile",
            cloakSeed: "73192",
          },
        });
        report.contextHandoff = {
          passiveClosed: true,
          deepOpened: Boolean(backend.getContext("real-deep")),
        };
        expect(report.contextHandoff).toEqual({
          passiveClosed: true,
          deepOpened: true,
        });
        const [deepTarget] = await deepContext.targets();
        deepCapture = new CdpManager();
        const deepResponses: Array<{ url: string; responseBody: string | null }> = [];
        deepCapture.on("response-captured", (response) => {
          deepResponses.push(response);
        });
        await deepCapture.start(deepTarget, "deep");
        const hookCalls: Array<{ tabId: string; value: unknown }> = [];
        const interactionCalls: Array<{ tabId: string; value: unknown }> = [];
        const attachBindings = async (target: typeof deepTarget): Promise<void> => {
          await target.exposeBinding("__aaSmokeBinding", (call) => {
            hookCalls.push({ tabId: call.tabId, value: call.args[0] });
          });
          await target.exposeBinding("__aaInteractionBinding", (call) => {
            interactionCalls.push({ tabId: call.tabId, value: call.args[0] });
          });
        };
        await attachBindings(deepTarget);
        await deepTarget.addInitScript(`
          globalThis.__aaDeepInit = true;
          addEventListener("DOMContentLoaded", () => {
            globalThis.__aaSmokeBinding?.({ kind: "init", url: location.href });
          }, { once: true });
          addEventListener("click", (event) => {
            globalThis.__aaInteractionBinding?.({
              kind: "click",
              id: event.target?.id ?? null,
              url: location.href
            });
          }, true);
        `);

        await deepTarget.navigate(`${origin}/deep`);
        await waitUntil(
          async () => hookCalls,
          (calls) =>
            calls.some(
              (call) =>
                (call.value as { url?: string }).url === `${origin}/deep`,
            ),
        );
        await waitUntil(
          async () => deepResponses,
          (responses) =>
            responses.some(
              (response) =>
                response.url === `${origin}/api/data` &&
                response.responseBody?.includes("backend-cdp-body-ok"),
            ),
        );
        await deepTarget.evaluate(`document.querySelector("#action").click()`);
        await waitUntil(
          async () => interactionCalls,
          (calls) =>
            calls.some(
              (call) => (call.value as { id?: string }).id === "action",
            ),
        );

        await deepTarget.reload();
        await waitUntil(
          async () => hookCalls.filter(
            (call) => (call.value as { url?: string }).url === `${origin}/deep`,
          ).length,
          (count) => count >= 2,
        );

        await deepTarget.evaluate(
          `window.open(${JSON.stringify(`${origin}/popup`)}, "_blank")`,
        );
        const popupTarget = await waitUntil(
          async () => (await deepContext.targets()).find((target) => target !== deepTarget),
          (target) => Boolean(target && target.url.includes("/popup")),
        );
        await attachBindings(popupTarget!);
        await waitUntil(
          async () => hookCalls,
          (calls) =>
            calls.some(
              (call) =>
                call.tabId === popupTarget!.tabId &&
                (call.value as { url?: string }).url === `${origin}/popup`,
            ),
        );
        await writeFile(deepScreenshotPath, await deepTarget.captureScreenshot());
        report.deep = {
          initPresent: await deepTarget.evaluate("globalThis.__aaDeepInit === true"),
          hookCalls,
          interactionCalls,
          capturedResponseBody: deepResponses.find(
            (response) => response.url === `${origin}/api/data`,
          )?.responseBody,
          popupUrl: popupTarget!.url,
          targetCount: (await deepContext.targets()).length,
        };
        expect(report.deep).toMatchObject({
          initPresent: true,
          capturedResponseBody: '{"message":"backend-cdp-body-ok"}',
          popupUrl: `${origin}/popup`,
          targetCount: 2,
        });
        await deepCapture.stop();
        deepCapture = null;
        await backend.closeContext("real-deep");
        report.passed = true;
      } finally {
        await deepCapture?.stop().catch(() => undefined);
        await backend.shutdown();
      }
    },
    180_000,
  );
  },
);
