import { EventEmitter } from "events";
import { readFileSync } from "fs";
import { join } from "path";
import type { BrowserTarget } from "../browser/contracts";

const HOOK_BINDING = "__anythingAnalyzerHookBinding";
const initializedTargets = new WeakSet<BrowserTarget>();
const hookDispatchers = new WeakMap<
  BrowserTarget,
  { callback: ((data: unknown) => void) | null }
>();

/**
 * Installs the Deep-mode JavaScript hooks through the browser-neutral target
 * contract. The init script is registered once and before the first navigation.
 */
export class JsInjector extends EventEmitter {
  private target: BrowserTarget | null = null;
  private hookScriptContent: string | null = null;

  async start(
    target: BrowserTarget,
    onHook?: (data: unknown) => void,
  ): Promise<void> {
    this.target = target;
    this.loadHookScript();
    if (!this.hookScriptContent) return;

    let dispatcher = hookDispatchers.get(target);
    if (!dispatcher) {
      dispatcher = { callback: onHook ?? null };
      hookDispatchers.set(target, dispatcher);
    } else {
      dispatcher.callback = onHook ?? null;
    }

    if (initializedTargets.has(target)) return;

    const source = buildHookSource(this.hookScriptContent, target.backendKind === "cloak");
    if (target.backendKind === "cloak") {
      await target.exposeBinding(HOOK_BINDING, (call) => {
        hookDispatchers.get(target)?.callback?.(call.args[0]);
      });
    }

    await target.addInitScript(source);
    initializedTargets.add(target);
    // Electron's initial WebContentsView has no document and keeps
    // executeJavaScript() pending until a navigation happens. The init script
    // already covers that first document; immediate injection is only needed
    // for a target that has loaded something.
    if (target.url) await target.evaluate(source).catch(() => undefined);
  }

  stop(): void {
    if (this.target) {
      const dispatcher = hookDispatchers.get(this.target);
      if (dispatcher) dispatcher.callback = null;
    }
    this.target = null;
  }

  private loadHookScript(): void {
    if (this.hookScriptContent) return;
    try {
      this.hookScriptContent = readFileSync(
        join(__dirname, "../preload/hook-script.js"),
        "utf-8",
      );
    } catch {
      this.hookScriptContent =
        "console.warn('[AnythingAnalyzer] Hook script not found')";
    }
  }
}

function buildHookSource(hookSource: string, useBinding: boolean): string {
  const bridge = useBinding
    ? `
      window.addEventListener("message", (event) => {
        if (event.data?.type === "ar-hook") {
          void globalThis["${HOOK_BINDING}"]?.(event.data);
        }
      });
    `
    : "";
  return `
    (() => {
      if (globalThis.__anythingAnalyzerHookInstalled) return;
      Object.defineProperty(globalThis, "__anythingAnalyzerHookInstalled", {
        value: true,
        configurable: false
      });
      ${bridge}
      ${hookSource}
    })();
  `;
}
