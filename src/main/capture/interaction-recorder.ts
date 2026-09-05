import { EventEmitter } from "events";
import { readFileSync } from "fs";
import { join } from "path";
import type { InteractionEvent, RawInteractionData } from "@shared/types";
import type { BrowserTarget } from "../browser/contracts";
import type { InteractionEventsRepo } from "../db/repositories";

const INTERACTION_BINDING = "__anythingAnalyzerInteractionBinding";
const initializedTargets = new WeakSet<BrowserTarget>();
const interactionDispatchers = new WeakMap<
  BrowserTarget,
  { callback: ((data: RawInteractionData) => void) | null }
>();
const INTERACTION_TYPES: readonly RawInteractionData["type"][] = [
  "click",
  "dblclick",
  "input",
  "scroll",
  "navigate",
  "hover",
];

interface RendererNotifier {
  isDestroyed(): boolean;
  send(channel: string, data: unknown): void;
}

/** Persists interaction data delivered by Deep-mode browser target hooks. */
export class InteractionRecorder extends EventEmitter {
  private sessionId: string | null = null;
  private renderer: RendererNotifier | null = null;
  private recording = false;
  private scriptContent: string | null = null;
  private readonly targets = new Map<string, BrowserTarget>();
  private controlQueue: Promise<void> = Promise.resolve();

  constructor(private readonly repo: InteractionEventsRepo) {
    super();
  }

  start(sessionId: string, renderer: RendererNotifier): void {
    this.sessionId = sessionId;
    this.renderer = renderer;
    this.recording = true;
    this.loadScript();
  }

  async attachTarget(target: BrowserTarget): Promise<void> {
    this.loadScript();
    const attachedSessionId = this.sessionId;
    if (!attachedSessionId || !this.scriptContent || target.isClosed()) return;

    let dispatcher = interactionDispatchers.get(target);
    if (!dispatcher) {
      dispatcher = { callback: (data) => this.handleInteraction(data) };
      interactionDispatchers.set(target, dispatcher);
    } else {
      dispatcher.callback = (data) => this.handleInteraction(data);
    }
    this.targets.set(target.tabId, target);

    try {
      if (!initializedTargets.has(target)) {
        const source = buildInteractionSource(
          this.scriptContent,
          target.backendKind === "cloak",
        );
        if (target.backendKind === "cloak") {
          await target.exposeBinding(INTERACTION_BINDING, (call) => {
            const data = normalizeInteractionData(call.args[0]);
            if (data) {
              interactionDispatchers.get(target)?.callback?.(data);
            }
          });
        }
        await target.addInitScript(source);
        initializedTargets.add(target);
        await target.evaluate(source).catch(() => undefined);
      }
    } catch (error) {
      this.detachTarget(target.tabId);
      throw error;
    }

    if (this.sessionId !== attachedSessionId) {
      this.detachTarget(target.tabId);
      return;
    }
    await this.setRecordingState(this.recording, target);
  }

  detachTarget(tabId: string): void {
    const target = this.targets.get(tabId);
    if (!target) return;
    const dispatcher = interactionDispatchers.get(target);
    if (dispatcher) dispatcher.callback = null;
    this.targets.delete(tabId);
  }

  pause(): Promise<void> {
    if (!this.sessionId) return Promise.resolve();
    this.recording = false;
    return this.setRecordingState(false);
  }

  resume(): Promise<void> {
    if (!this.sessionId) return Promise.resolve();
    this.recording = true;
    return this.setRecordingState(true);
  }

  syncTargetRecordingState(target: BrowserTarget): Promise<void> {
    return this.setRecordingState(this.recording, target);
  }

  async stop(): Promise<void> {
    this.recording = false;
    this.sessionId = null;
    await this.setRecordingState(false);
    for (const target of this.targets.values()) {
      const dispatcher = interactionDispatchers.get(target);
      if (dispatcher) dispatcher.callback = null;
    }
    this.targets.clear();
    this.renderer = null;
  }

  handleInteraction(data: RawInteractionData): void {
    if (!this.recording || !this.sessionId) return;

    let sequence: number;
    try {
      sequence = this.repo.getNextSequence(this.sessionId);
    } catch (error) {
      console.warn(
        "[InteractionRecorder] getNextSequence failed:",
        errorMessage(error),
      );
      return;
    }

    const event: Omit<InteractionEvent, "id"> = {
      session_id: this.sessionId,
      sequence,
      type: data.type,
      timestamp: data.timestamp,
      x: data.x ?? null,
      y: data.y ?? null,
      viewport_x: data.viewportX ?? null,
      viewport_y: data.viewportY ?? null,
      selector: data.selector ?? null,
      xpath: data.xpath ?? null,
      tag_name: data.tagName ?? null,
      element_text: data.elementText ?? null,
      attributes: data.attributes ? JSON.stringify(data.attributes) : null,
      bounding_rect: data.boundingRect
        ? JSON.stringify(data.boundingRect)
        : null,
      input_value: data.inputValue ?? null,
      key: data.key ?? null,
      scroll_x: data.scrollX ?? null,
      scroll_y: data.scrollY ?? null,
      scroll_dx: data.scrollDX ?? null,
      scroll_dy: data.scrollDY ?? null,
      url: data.url,
      page_title: data.pageTitle ?? null,
      path: data.path ? JSON.stringify(data.path) : null,
      created_at: Date.now(),
    };

    try {
      this.repo.insert(event);
    } catch (error) {
      console.warn("[InteractionRecorder] Insert failed:", errorMessage(error));
      return;
    }

    if (this.renderer && !this.renderer.isDestroyed()) {
      this.renderer.send("interaction:recorded", {
        type: data.type,
        sequence,
        timestamp: data.timestamp,
      });
    }
    this.emit("interaction", event);
  }

  isRecording(): boolean {
    return this.recording;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  private loadScript(): void {
    if (this.scriptContent) return;
    try {
      this.scriptContent = readFileSync(
        join(__dirname, "../preload/interaction-hook.js"),
        "utf-8",
      );
    } catch {
      this.scriptContent =
        "console.warn('[AnythingAnalyzer] Interaction hook script not found')";
    }
  }

  private setRecordingState(
    recording: boolean,
    onlyTarget?: BrowserTarget,
  ): Promise<void> {
    const applyState = async (): Promise<void> => {
      const targets = onlyTarget
        ? this.targets.get(onlyTarget.tabId) === onlyTarget
          ? [onlyTarget]
          : []
        : [...this.targets.values()];
      await Promise.allSettled(
        targets.map((target) =>
          this.setTargetRecordingState(target, recording),
        ),
      );
    };
    this.controlQueue = this.controlQueue.then(applyState, applyState);
    return this.controlQueue;
  }

  private async setTargetRecordingState(
    target: BrowserTarget,
    recording: boolean = this.recording,
  ): Promise<void> {
    if (target.isClosed()) return;
    await target.evaluate(
      `window.postMessage({type:"ar-interaction-control",recording:${recording}},"*")`,
    );
  }
}

function buildInteractionSource(script: string, useBinding: boolean): string {
  const bridge = useBinding
    ? `
      window.addEventListener("message", (event) => {
        if (event.data?.type === "ar-interaction") {
          void globalThis["${INTERACTION_BINDING}"]?.(event.data);
        }
      });
    `
    : "";
  return `
    (() => {
      if (globalThis.__anythingAnalyzerInteractionInstalled) return;
      Object.defineProperty(globalThis, "__anythingAnalyzerInteractionInstalled", {
        value: true,
        configurable: false
      });
      ${bridge}
      ${script}
    })();
  `;
}

function normalizeInteractionData(value: unknown): RawInteractionData | null {
  if (!isRecord(value)) return null;
  const candidate = value as Record<string, unknown>;
  const typeValue =
    candidate.type === "ar-interaction"
      ? candidate.interactionType
      : candidate.type;
  const type = normalizeInteractionType(typeValue);
  const timestamp = finiteNumber(candidate.timestamp);
  if (
    !type ||
    timestamp === undefined ||
    typeof candidate.url !== "string"
  ) {
    return null;
  }
  return {
    type,
    timestamp,
    x: finiteNumber(candidate.x),
    y: finiteNumber(candidate.y),
    viewportX: finiteNumber(candidate.viewportX),
    viewportY: finiteNumber(candidate.viewportY),
    selector: optionalString(candidate.selector),
    xpath: optionalString(candidate.xpath),
    tagName: optionalString(candidate.tagName),
    elementText: optionalString(candidate.elementText),
    attributes: stringRecord(candidate.attributes),
    boundingRect: boundingRect(candidate.boundingRect),
    inputValue: optionalString(candidate.inputValue),
    key: optionalString(candidate.key),
    scrollX: finiteNumber(candidate.scrollX),
    scrollY: finiteNumber(candidate.scrollY),
    scrollDX: finiteNumber(candidate.scrollDX),
    scrollDY: finiteNumber(candidate.scrollDY),
    url: candidate.url,
    pageTitle: optionalString(candidate.pageTitle),
    path: interactionPath(candidate.path),
  };
}

function normalizeInteractionType(
  value: unknown,
): RawInteractionData["type"] | null {
  return typeof value === "string" &&
    INTERACTION_TYPES.includes(value as RawInteractionData["type"])
    ? (value as RawInteractionData["type"])
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => typeof item === "string")) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function boundingRect(
  value: unknown,
): RawInteractionData["boundingRect"] | undefined {
  if (!isRecord(value)) return undefined;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
  ) {
    return undefined;
  }
  return { x, y, width, height };
}

function interactionPath(value: unknown): RawInteractionData["path"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const points: NonNullable<RawInteractionData["path"]> = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const x = finiteNumber(item.x);
    const y = finiteNumber(item.y);
    const t = finiteNumber(item.t);
    if (x === undefined || y === undefined || t === undefined) return undefined;
    points.push({ x, y, t });
  }
  return points;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
