import type { InteractionEvent } from "@shared/types";
import type { BrowserTarget, CdpLease, HumanInput } from "../browser/contracts";

export interface ReplayOptions {
  speed: number;
  skipMoves: boolean;
}

export interface BrowserAction {
  type: string;
  selector?: string;
  text?: string;
  url?: string;
  x?: number;
  y?: number;
  scrollDelta?: number;
}

export interface ReplayResult {
  success: boolean;
  stepsCompleted: number;
  error?: string;
}

/** Replays recorded interactions through a shared, reference-counted CDP lease. */
export class ReplayEngine {
  private activeRun: AbortController | null = null;

  async replay(
    target: BrowserTarget,
    events: InteractionEvent[],
    options: ReplayOptions = { speed: 1, skipMoves: false },
  ): Promise<ReplayResult> {
    if (!Number.isFinite(options.speed) || options.speed <= 0) {
      return { success: false, stepsCompleted: 0, error: "Replay speed must be greater than 0" };
    }
    if (target.isClosed()) {
      return { success: false, stepsCompleted: 0, error: "Browser target is closed" };
    }

    this.abort();
    const controller = new AbortController();
    this.activeRun = controller;
    let completed = 0;
    let lease: CdpLease | null = null;
    const human = target.getHumanInput?.() ?? null;

    try {
      lease = await (await target.getCdpTransport()).acquire("replay");
      for (let index = 0; index < events.length; index += 1) {
        this.assertActive(target, controller.signal);
        const event = events[index];
        if (options.skipMoves && event.type === "hover") continue;

        await this.executeStep(target, lease, human, event, controller.signal);
        completed += 1;

        const nextEvent = events[index + 1];
        if (nextEvent) {
          const delay = (nextEvent.timestamp - event.timestamp) / options.speed;
          await this.wait(Math.min(Math.max(delay, 10), 3_000), controller.signal);
        }
      }
      return { success: true, stepsCompleted: completed };
    } catch (error) {
      const aborted = controller.signal.aborted;
      return {
        success: false,
        stepsCompleted: completed,
        error: aborted ? "Replay cancelled" : errorMessage(error),
      };
    } finally {
      await lease?.release().catch(() => undefined);
      if (this.activeRun === controller) this.activeRun = null;
    }
  }

  abort(): void {
    this.activeRun?.abort();
    this.activeRun = null;
  }

  async executeAction(
    target: BrowserTarget,
    action: BrowserAction,
  ): Promise<{ success: boolean; error?: string }> {
    if (target.isClosed()) return { success: false, error: "Browser target is closed" };

    const human = target.getHumanInput?.() ?? null;
    let lease: CdpLease | null = null;
    try {
      lease = await (await target.getCdpTransport()).acquire("replay:action");
      switch (action.type) {
        case "click": {
          if (action.selector) {
            if (human) {
              await human.click({ selector: action.selector, clickCount: 1 });
            } else {
              const coords = await this.resolveElementCenter(lease, action.selector);
              if (!coords) return { success: false, error: `Element not found: ${action.selector}` };
              await this.clickAt(lease, coords.x, coords.y, 1);
            }
          } else if (action.x != null && action.y != null) {
            if (human) await human.click({ x: action.x, y: action.y, clickCount: 1 });
            else await this.clickAt(lease, action.x, action.y, 1);
          } else {
            return { success: false, error: "click requires selector or x/y coordinates" };
          }
          break;
        }
        case "type": {
          if (action.text == null) return { success: false, error: "type requires text" };
          if (human) {
            await human.type({ selector: action.selector, text: action.text });
          } else {
            if (action.selector) {
              await lease.send("Runtime.evaluate", {
                expression: `document.querySelector(${JSON.stringify(action.selector)})?.focus()`,
              });
            }
            await lease.send("Input.insertText", { text: action.text });
          }
          break;
        }
        case "scroll":
          if (human) {
            await human.scroll({
              x: action.x ?? 400,
              y: action.y ?? 300,
              deltaX: 0,
              deltaY: action.scrollDelta ?? 200,
            });
          } else {
            await lease.send("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              x: action.x ?? 400,
              y: action.y ?? 300,
              deltaX: 0,
              deltaY: action.scrollDelta ?? 200,
            });
          }
          break;
        case "navigate":
          if (!action.url) return { success: false, error: "navigate requires url" };
          await target.navigate(action.url);
          break;
        default:
          return { success: false, error: `Unknown action type: ${action.type}` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    } finally {
      await lease?.release().catch(() => undefined);
    }
  }

  private async executeStep(
    target: BrowserTarget,
    lease: CdpLease,
    human: HumanInput | null,
    event: InteractionEvent,
    signal: AbortSignal,
  ): Promise<void> {
    const x = event.viewport_x ?? event.x ?? 0;
    const y = event.viewport_y ?? event.y ?? 0;
    switch (event.type) {
      case "click":
      case "dblclick": {
        const clickCount = event.type === "dblclick" ? 2 : 1;
        // Prefer the selector so humanized replay lands on the element even if
        // the layout shifted since recording; fall back to coordinates.
        if (human) {
          await human.click(
            event.selector
              ? { selector: event.selector, clickCount }
              : { x, y, clickCount },
          );
        } else {
          await this.clickAt(lease, x, y, clickCount);
        }
        break;
      }
      case "input":
        if (event.selector && event.input_value != null) {
          if (human) {
            await human.type({ selector: event.selector, text: event.input_value });
          } else {
            await lease.send("Runtime.evaluate", {
              expression: `(() => {
                const element = document.querySelector(${JSON.stringify(event.selector)});
                if (!element) return false;
                element.focus();
                if ("value" in element) element.value = "";
                element.dispatchEvent(new Event("input", { bubbles: true }));
                return true;
              })()`,
              returnByValue: true,
            });
            await lease.send("Input.insertText", { text: event.input_value });
          }
        }
        break;
      case "scroll":
        if (human) {
          await human.scroll({
            x: event.viewport_x ?? 400,
            y: event.viewport_y ?? 300,
            deltaX: event.scroll_dx ?? 0,
            deltaY: event.scroll_dy ?? 0,
          });
        } else {
          await lease.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: event.viewport_x ?? 400,
            y: event.viewport_y ?? 300,
            deltaX: event.scroll_dx ?? 0,
            deltaY: event.scroll_dy ?? 0,
          });
        }
        break;
      case "navigate":
        if (event.url) await target.navigate(event.url);
        break;
      case "hover":
        if (event.path) {
          const points = JSON.parse(event.path) as Array<{ x: number; y: number; t: number }>;
          if (human) {
            this.assertActive(target, signal);
            await human.move(points.map((point) => ({ x: point.x, y: point.y })));
          } else {
            for (const point of points) {
              this.assertActive(target, signal);
              await lease.send("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: point.x,
                y: point.y,
              });
              await this.wait(20, signal);
            }
          }
        }
        break;
    }
  }

  private async clickAt(
    lease: CdpLease,
    x: number,
    y: number,
    clickCount: number,
  ): Promise<void> {
    await lease.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await lease.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount,
    });
    await lease.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount,
    });
  }

  private async resolveElementCenter(
    lease: CdpLease,
    selector: string,
  ): Promise<{ x: number; y: number } | null> {
    const result = await lease.send<{
      result?: { value?: { x: number; y: number } | null };
    }>("Runtime.evaluate", {
      expression: `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`,
      returnByValue: true,
    });
    return result.result?.value ?? null;
  }

  private assertActive(target: BrowserTarget, signal: AbortSignal): void {
    if (signal.aborted) throw new Error("Replay cancelled");
    if (target.isClosed()) throw new Error("Browser target closed during replay");
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error("Replay cancelled"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, Math.max(ms, 5));
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("Replay cancelled"));
        },
        { once: true },
      );
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
