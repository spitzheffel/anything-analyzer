import type { BrowserBackendKind } from "@shared/types";
import type { ProxyConfig } from "@shared/types";
import {
  BrowserBackendError,
  supportsCaptureMode,
  type BrowserBackend,
  type BrowserCapabilities,
  type BrowserContext,
  type BrowserContextEvent,
  type BrowserContextOptions,
  type BrowserTarget,
  type Unsubscribe,
} from "./contracts";

export interface OpenBrowserSessionOptions extends BrowserContextOptions {
  backendKind: BrowserBackendKind;
}

export type BrowserCoordinatorEvent = BrowserContextEvent & {
  backendKind: BrowserBackendKind;
};

interface ManagedContext {
  backend: BrowserBackend;
  context: BrowserContext;
  unsubscribe: Unsubscribe;
}

export class BrowserCoordinatorShutdownError extends BrowserBackendError {
  readonly failures: readonly unknown[];

  constructor(failures: readonly unknown[]) {
    super(
      "BACKEND_FAILURE",
      `Browser shutdown failed in ${failures.length} operation(s)`,
      { cause: new AggregateError(failures, "Browser shutdown failures") },
    );
    this.name = "BrowserCoordinatorShutdownError";
    this.failures = failures;
  }
}

/**
 * Owns browser backend selection and Session/target routing. Persistence and
 * profile resolution deliberately live outside this class.
 */
export class BrowserCoordinator {
  private readonly backends = new Map<BrowserBackendKind, BrowserBackend>();
  private readonly startedBackends = new Set<BrowserBackendKind>();
  private readonly contexts = new Map<string, ManagedContext>();
  private readonly activeTargetIds = new Map<string, string>();
  private readonly listeners = new Set<(event: BrowserCoordinatorEvent) => void>();
  private activeSessionId: string | null = null;
  private transitionTail: Promise<void> = Promise.resolve();
  private shutdownPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private shutDown = false;

  registerBackend(backend: BrowserBackend): void {
    this.ensureAcceptingWork();
    if (this.backends.has(backend.kind)) {
      throw new BrowserBackendError(
        "BACKEND_ALREADY_REGISTERED",
        `Browser backend ${backend.kind} is already registered`,
        { backendKind: backend.kind },
      );
    }
    this.backends.set(backend.kind, backend);
  }

  hasBackend(kind: BrowserBackendKind): boolean {
    return this.backends.has(kind);
  }

  hasOpenSession(sessionId: string): boolean {
    const managed = this.contexts.get(sessionId);
    return Boolean(managed && !managed.context.isClosed());
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  async openSession(options: OpenBrowserSessionOptions): Promise<BrowserContext>;
  async openSession(
    backendKind: BrowserBackendKind,
    options: BrowserContextOptions,
  ): Promise<BrowserContext>;
  async openSession(
    optionsOrBackend: OpenBrowserSessionOptions | BrowserBackendKind,
    contextOptions?: BrowserContextOptions,
  ): Promise<BrowserContext> {
    const options = normalizeOpenOptions(optionsOrBackend, contextOptions);
    return this.enqueueTransition(async () => {
      this.ensureAcceptingWork();
      let existing = this.contexts.get(options.sessionId);
      if (existing?.context.isClosed()) {
        existing.unsubscribe();
        this.contexts.delete(options.sessionId);
        this.activeTargetIds.delete(options.sessionId);
        existing = undefined;
      }
      if (existing) {
        if (existing.backend.kind !== options.backendKind) {
          throw new BrowserBackendError(
            "CONTEXT_BACKEND_MISMATCH",
            `Session ${options.sessionId} is already open with ${existing.backend.kind}`,
            {
              backendKind: options.backendKind,
              sessionId: options.sessionId,
              contextId: existing.context.id,
            },
          );
        }
        return existing.context;
      }

      const backend = this.requireBackend(options.backendKind);
      if (
        options.captureMode &&
        !supportsCaptureMode(backend.capabilities, options.captureMode)
      ) {
        throw new BrowserBackendError(
          "CAPABILITY_UNSUPPORTED",
          `${options.backendKind} does not support ${options.captureMode} capture`,
          {
            backendKind: options.backendKind,
            sessionId: options.sessionId,
          },
        );
      }

      if (!this.startedBackends.has(backend.kind)) {
        await backend.start();
        this.startedBackends.add(backend.kind);
      }

      const { backendKind, ...browserOptions } = options;
      const context = await backend.openContext(browserOptions);
      if (
        context.sessionId !== options.sessionId ||
        context.backendKind !== backendKind
      ) {
        await context.close().catch(() => undefined);
        throw new BrowserBackendError(
          "CONTEXT_BACKEND_MISMATCH",
          `Backend ${backendKind} returned a context with inconsistent identity`,
          {
            backendKind,
            sessionId: options.sessionId,
            contextId: context.id,
          },
        );
      }

      const unsubscribe = context.onEvent((event) => {
        this.handleContextEvent(backend, context, event);
      });
      this.contexts.set(options.sessionId, { backend, context, unsubscribe });
      return context;
    });
  }

  async setActiveSession(sessionId: string | null): Promise<BrowserContext | null> {
    return this.enqueueTransition(async () => {
      this.ensureAcceptingWork();
      if (sessionId === null) {
        await this.hideActiveEmbeddedTarget();
        this.activeSessionId = null;
        return null;
      }

      const managed = this.requireManagedContext(sessionId);
      if (this.activeSessionId !== sessionId) await this.hideActiveEmbeddedTarget();
      await managed.context.activate();
      this.activeSessionId = sessionId;
      await this.refreshActiveTarget(managed.context, true);
      return managed.context;
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    return this.enqueueTransition(async () => {
      const managed = this.contexts.get(sessionId);
      if (!managed) return;
      if (this.activeSessionId === sessionId) {
        await this.hideActiveEmbeddedTarget();
        this.activeSessionId = null;
      }

      try {
        await managed.backend.closeContext(sessionId);
      } catch (error) {
        // A failed backend close can leave a live native Context behind. Keep
        // owning it so a later close or shutdown can retry instead of orphaning
        // the backend/runtime resource.
        if (managed.context.isClosed()) {
          this.forgetContext(sessionId, managed);
        }
        throw error;
      }
      this.forgetContext(sessionId, managed);
    });
  }

  async deletePersistentProfile(
    backendKind: BrowserBackendKind,
    profileKey: string,
  ): Promise<void> {
    return this.enqueueTransition(async () => {
      this.ensureAcceptingWork();
      const backend = this.requireBackend(backendKind);
      if (!this.startedBackends.has(backend.kind)) {
        await backend.start();
        this.startedBackends.add(backend.kind);
      }
      await backend.deletePersistentProfile(profileKey);
    });
  }

  async setActiveTarget(tabId: string): Promise<BrowserTarget>;
  async setActiveTarget(sessionId: string, tabId: string): Promise<BrowserTarget>;
  async setActiveTarget(sessionOrTabId: string, requestedTabId?: string): Promise<BrowserTarget> {
    return this.enqueueTransition(async () => {
      this.ensureAcceptingWork();
      const sessionId = requestedTabId === undefined
        ? this.requireActiveSessionId()
        : sessionOrTabId;
      const tabId = requestedTabId ?? sessionOrTabId;
      const managed = this.requireManagedContext(sessionId);

      if (this.activeSessionId !== sessionId) await this.hideActiveEmbeddedTarget();
      await managed.context.activate();
      const target = await managed.context.activateTarget(tabId);
      this.activeSessionId = sessionId;
      this.activeTargetIds.set(sessionId, target.tabId);
      if (target.setVisible) await target.setVisible(true);
      return target;
    });
  }

  getActiveContext(): BrowserContext | null {
    if (!this.activeSessionId) return null;
    return this.contexts.get(this.activeSessionId)?.context ?? null;
  }

  getActiveTarget(): BrowserTarget | null {
    if (!this.activeSessionId) return null;
    const managed = this.contexts.get(this.activeSessionId);
    const tabId = this.activeTargetIds.get(this.activeSessionId);
    if (!managed || !tabId) return null;
    return managed.context.getTarget(tabId);
  }

  resolveContext(sessionId: string): BrowserContext {
    return this.requireManagedContext(sessionId).context;
  }

  resolveTarget(sessionId: string, tabId?: string): BrowserTarget {
    const context = this.resolveContext(sessionId);
    const resolvedTabId = tabId ?? this.activeTargetIds.get(sessionId);
    const target = resolvedTabId ? context.getTarget(resolvedTabId) : null;
    if (!target) {
      throw new BrowserBackendError(
        "TARGET_NOT_FOUND",
        resolvedTabId
          ? `Tab ${resolvedTabId} was not found in Session ${sessionId}`
          : `Session ${sessionId} has no active tab`,
        {
          backendKind: context.backendKind,
          sessionId,
          contextId: context.id,
          ...(resolvedTabId ? { targetId: resolvedTabId } : {}),
        },
      );
    }
    return target;
  }

  getCapabilities(
    backendOrSessionId?: BrowserBackendKind | string,
  ): Readonly<BrowserCapabilities> {
    if (!backendOrSessionId) {
      const context = this.getActiveContext();
      if (!context) {
        throw new BrowserBackendError("CONTEXT_NOT_FOUND", "No browser Session is active");
      }
      return this.requireBackend(context.backendKind).capabilities;
    }
    if (backendOrSessionId === "electron" || backendOrSessionId === "cloak") {
      return this.requireBackend(backendOrSessionId).capabilities;
    }
    const managed = this.requireManagedContext(backendOrSessionId);
    return managed.backend.capabilities;
  }

  async updateOpenContextProxies(
    backendKind: BrowserBackendKind,
    nextProxy: ProxyConfig | null,
    rollbackProxy: ProxyConfig | null,
  ): Promise<void> {
    return this.enqueueTransition(async () => {
      this.ensureAcceptingWork();
      const backend = this.requireBackend(backendKind);
      if (backend.capabilities.proxyUpdate !== "runtime") {
        throw new BrowserBackendError(
          "CAPABILITY_UNSUPPORTED",
          `${backendKind} does not support runtime proxy updates`,
          { backendKind },
        );
      }

      const contexts = [...this.contexts.values()]
        .filter(
          (managed) =>
            managed.backend.kind === backendKind && !managed.context.isClosed(),
        )
        .map((managed) => managed.context);
      const attempted: BrowserContext[] = [];
      try {
        for (const context of contexts) {
          if (!context.updateProxy) {
            throw new BrowserBackendError(
              "CAPABILITY_UNSUPPORTED",
              `${backendKind} Context ${context.id} cannot update its proxy at runtime`,
              {
                backendKind,
                sessionId: context.sessionId,
                contextId: context.id,
              },
            );
          }
          attempted.push(context);
          await context.updateProxy(nextProxy);
        }
      } catch (error) {
        const rollbackResults = await Promise.allSettled(
          attempted.reverse().map((context) => context.updateProxy!(rollbackProxy)),
        );
        const rollbackFailures = rollbackResults.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (rollbackFailures.length > 0) {
          throw new BrowserBackendError(
            "BACKEND_FAILURE",
            `Failed to update ${backendKind} proxies and ${rollbackFailures.length} rollback operation(s) failed`,
            {
              backendKind,
              cause: new AggregateError(
                [error, ...rollbackFailures.map((result) => result.reason)],
                `${backendKind} proxy update and rollback failures`,
              ),
            },
          );
        }
        throw error;
      }
    });
  }

  onEvent(listener: (event: BrowserCoordinatorEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  shutdown(): Promise<void> {
    if (this.shutDown) return Promise.resolve();
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;

    const attempt = this.enqueueTransition(() => this.performShutdown());
    const trackedAttempt = attempt.finally(() => {
      if (this.shutdownPromise === trackedAttempt) this.shutdownPromise = null;
    });
    this.shutdownPromise = trackedAttempt;
    return trackedAttempt;
  }

  private async performShutdown(): Promise<void> {
    const failures: unknown[] = [];
    const managedContexts = [...this.contexts.entries()];
    const contextResults = await Promise.allSettled(
      managedContexts.map(([sessionId, managed]) =>
        managed.backend.closeContext(sessionId),
      ),
    );

    const backendResults = await Promise.allSettled(
      [...this.backends.values()].map((backend) => backend.shutdown()),
    );
    for (const result of backendResults) {
      if (result.status === "rejected") failures.push(result.reason);
    }

    for (const [index, [sessionId, managed]] of managedContexts.entries()) {
      if (managed.context.isClosed()) {
        this.forgetContext(sessionId, managed);
        continue;
      }
      const result = contextResults[index];
      failures.push(
        result.status === "rejected"
          ? result.reason
          : new Error(`Browser Context ${managed.context.id} remained open after shutdown`),
      );
    }

    if (failures.length > 0) throw new BrowserCoordinatorShutdownError(failures);

    this.contexts.clear();
    this.activeTargetIds.clear();
    this.activeSessionId = null;
    this.listeners.clear();
    this.startedBackends.clear();
    this.shutDown = true;
  }

  private handleContextEvent(
    backend: BrowserBackend,
    context: BrowserContext,
    event: BrowserContextEvent,
  ): void {
    // Reject malformed backend events rather than leaking them across Sessions.
    if (event.sessionId !== context.sessionId || event.contextId !== context.id) return;
    if (event.type === "target-created" && event.target.tabId !== event.tabId) return;

    if (event.type === "target-activated") {
      this.activeTargetIds.set(context.sessionId, event.tabId);
    } else if (event.type === "target-closed") {
      if (this.activeTargetIds.get(context.sessionId) === event.tabId) {
        this.activeTargetIds.delete(context.sessionId);
      }
    }

    const scopedEvent: BrowserCoordinatorEvent = {
      ...event,
      backendKind: backend.kind,
    };
    for (const listener of this.listeners) {
      try {
        listener(scopedEvent);
      } catch (error) {
        console.error("[BrowserCoordinator] Event listener failed:", error);
      }
    }

    // Consumers route disconnect/reset notifications by the active Session.
    // Keep that routing identity intact until every synchronous listener has
    // observed the event, then retire the closed Context.
    if (event.type === "disconnected") {
      this.activeTargetIds.delete(context.sessionId);
      const managed = this.contexts.get(context.sessionId);
      if (managed?.context === context && context.isClosed()) {
        managed.unsubscribe();
        this.contexts.delete(context.sessionId);
        if (this.activeSessionId === context.sessionId) {
          this.activeSessionId = null;
        }
      }
    }
  }

  private forgetContext(sessionId: string, managed: ManagedContext): void {
    if (this.contexts.get(sessionId) !== managed) return;
    managed.unsubscribe();
    this.contexts.delete(sessionId);
    this.activeTargetIds.delete(sessionId);
  }

  private async refreshActiveTarget(
    context: BrowserContext,
    makeVisible: boolean,
  ): Promise<void> {
    const targets = await context.targets();
    const target = targets.find((candidate) => candidate.getState().isActive) ?? targets[0];
    if (!target) {
      this.activeTargetIds.delete(context.sessionId);
      return;
    }
    this.activeTargetIds.set(context.sessionId, target.tabId);
    if (makeVisible && target.setVisible) await target.setVisible(true);
  }

  private async hideActiveEmbeddedTarget(): Promise<void> {
    const target = this.getActiveTarget();
    if (target?.setVisible) await target.setVisible(false);
  }

  private requireBackend(kind: BrowserBackendKind): BrowserBackend {
    const backend = this.backends.get(kind);
    if (!backend) {
      throw new BrowserBackendError(
        "BACKEND_NOT_AVAILABLE",
        `Browser backend ${kind} is not available in this build`,
        { backendKind: kind },
      );
    }
    return backend;
  }

  private requireManagedContext(sessionId: string): ManagedContext {
    const managed = this.contexts.get(sessionId);
    if (!managed || managed.context.isClosed()) {
      throw new BrowserBackendError(
        "CONTEXT_NOT_FOUND",
        `Browser context for Session ${sessionId} was not found`,
        { sessionId },
      );
    }
    return managed;
  }

  private requireActiveSessionId(): string {
    if (!this.activeSessionId) {
      throw new BrowserBackendError("CONTEXT_NOT_FOUND", "No browser Session is active");
    }
    return this.activeSessionId;
  }

  private ensureAcceptingWork(): void {
    if (this.shuttingDown || this.shutDown) {
      throw new BrowserBackendError(
        "BACKEND_SHUTTING_DOWN",
        "Browser coordinator is shutting down",
      );
    }
  }

  private enqueueTransition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitionTail.then(operation, operation);
    this.transitionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function normalizeOpenOptions(
  optionsOrBackend: OpenBrowserSessionOptions | BrowserBackendKind,
  contextOptions?: BrowserContextOptions,
): OpenBrowserSessionOptions {
  if (typeof optionsOrBackend !== "string") return optionsOrBackend;
  if (!contextOptions) {
    throw new BrowserBackendError(
      "INVALID_ARGUMENT",
      "Browser context options are required",
      { backendKind: optionsOrBackend },
    );
  }
  return { ...contextOptions, backendKind: optionsOrBackend };
}
