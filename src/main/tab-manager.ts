import { EventEmitter } from "events";
import { v4 as uuidv4 } from "uuid";
import { BrowserWindow, WebContentsView } from "electron";
import type {
  BrowserWindowConstructorOptions,
  HandlerDetails,
  WebContents,
  Session as ElectronSession,
} from "electron";
import { join } from "path";
import { resolveOwnedTabMap } from "./tab-group-routing";

interface TabInfo {
  id: string;
  view: WebContentsView;
  /** Fixed at creation; never inferred from whichever Session is visible later. */
  groupId: string | null;
  openerTabId?: string;
  url: string;
  title: string;
  isLoading: boolean;
}

/** Snapshot of a session's tab group state (kept alive while hidden). */
interface SessionTabGroup {
  tabs: Map<string, TabInfo>;
  activeTabId: string | null;
  electronSession: ElectronSession;
}

interface CreateOwnedTabOptions {
  groupId: string | null;
  electronSession: ElectronSession | null;
  url?: string;
  activate: boolean;
  browserWindowOptions?: BrowserWindowConstructorOptions;
  openerTabId?: string;
  /** Popup navigation is completed by Electron to preserve POST and opener state. */
  loadUrl?: boolean;
}

/**
 * TabManager — Manages multiple browser tabs as WebContentsView instances.
 * Each tab gets its own WebContentsView, only the active tab is displayed.
 * Popup windows (window.open) are intercepted and opened as new tabs.
 *
 * Supports per-session tab groups: each app session owns an isolated set of
 * tabs. Switching sessions hides the old group and restores (or creates) the
 * new group — WebContentsView instances stay alive so page state is preserved.
 */
export class TabManager extends EventEmitter {
  /** Tabs for the currently visible session group. */
  private tabs = new Map<string, TabInfo>();
  private activeTabId: string | null = null;
  private mainWindow: BrowserWindow | null = null;
  private boundsCalculator: (() => Electron.Rectangle) | null = null;
  private visibilityChecker: (() => boolean) | null = null;
  /** Track destroyed tabs to avoid double-close */
  private destroyedTabs = new Set<string>();
  /** True when app is quitting: no tab recreation/new tabs allowed */
  private isShuttingDown = false;
  /** Electron session for the active app session (partition isolation) */
  private activeElectronSession: ElectronSession | null = null;

  // ---- Per-session tab groups ----
  /** Stored tab groups for sessions that are not currently visible. */
  private sessionGroups = new Map<string, SessionTabGroup>();
  /** The session group ID currently driving `this.tabs`. */
  private currentGroupId: string | null = null;

  /**
   * Initialize with the main window and a bounds calculator callback.
   */
  init(
    mainWindow: BrowserWindow,
    boundsCalculator: () => Electron.Rectangle,
    visibilityChecker?: () => boolean,
  ): void {
    this.mainWindow = mainWindow;
    this.boundsCalculator = boundsCalculator;
    this.visibilityChecker = visibilityChecker ?? null;
  }

  /**
   * Switch the visible tab group to a different session.
   * - Hides (but keeps alive) the current session's tabs.
   * - Restores a previously stored group, or creates a blank tab if first visit.
   * - Emits tab events so the renderer UI stays in sync.
   *
   * Returns true if a new blank tab was created (caller may want to navigate).
   */
  switchSessionGroup(groupId: string, elSession: ElectronSession): boolean {
    if (this.currentGroupId === groupId) return false;

    // 1. Stash current group ---------------------------------------------------
    if (this.currentGroupId !== null) {
      // Remove ALL tab views from the window (stashing this group)
      this.detachAllViews();

      this.sessionGroups.set(this.currentGroupId, {
        tabs: this.tabs,
        activeTabId: this.activeTabId,
        electronSession: this.activeElectronSession!,
      });

      // Tell renderer to clear its tab list (emit close for every visible tab)
      for (const [, tab] of this.tabs) {
        this.emit("tab-closed", { tabId: tab.id, groupId: tab.groupId });
      }
    } else if (this.tabs.size > 0) {
      // First-ever switch: there may be initial default-session tabs.
      // Stash them under a special key so they don't leak.
      this.detachAllViews();
      for (const [, tab] of this.tabs) {
        this.emit("tab-closed", { tabId: tab.id, groupId: tab.groupId });
      }
      // Destroy default-session tabs — they can't be reused in a partition
      for (const [tabId, tab] of this.tabs) {
        this.destroyedTabs.add(tabId);
        try { tab.view.webContents.close(); } catch { /* ignore */ }
      }
    }

    // Reset working state
    this.tabs = new Map();
    this.activeTabId = null;
    this.activeElectronSession = elSession;
    this.currentGroupId = groupId;

    // 2. Restore or create group -----------------------------------------------
    const existing = this.sessionGroups.get(groupId);
    let createdNew = false;

    if (existing && existing.tabs.size > 0) {
      // Restore previously stashed tabs
      this.tabs = existing.tabs;
      this.activeElectronSession = existing.electronSession;
      this.sessionGroups.delete(groupId);

      // Re-add all views as children (hidden) — they were detached when stashed
      if (this.mainWindow) {
        for (const [, tab] of this.tabs) {
          try {
            tab.view.setBounds(TabManager.HIDDEN_BOUNDS);
            this.mainWindow.contentView.addChildView(tab.view);
          } catch { /* view may have been destroyed */ }
        }
      }

      // Notify renderer about restored tabs
      for (const [, tab] of this.tabs) {
        this.emit("tab-created", {
          id: tab.id,
          url: tab.url,
          title: tab.title,
          groupId: tab.groupId,
          ...(tab.openerTabId ? { openerTabId: tab.openerTabId } : {}),
        });
      }

      // Activate the tab that was active before
      const restoreId =
        existing.activeTabId && this.tabs.has(existing.activeTabId)
          ? existing.activeTabId
          : this.tabs.keys().next().value;
      if (restoreId) {
        this.activateTab(restoreId);
      }
    } else {
      // First visit to this session — create a blank tab
      this.sessionGroups.delete(groupId); // remove stale empty entry if any
      this.createTab();
      createdNew = true;
    }

    return createdNew;
  }

  /**
   * Destroy all tabs belonging to a specific session group.
   * Used when deleting a session.
   */
  destroySessionGroup(groupId: string): void {
    // If it's the current group, clear visible tabs
    if (this.currentGroupId === groupId) {
      this.destroyAllTabs();
      this.currentGroupId = null;
      return;
    }
    // Otherwise destroy the stashed group
    const group = this.sessionGroups.get(groupId);
    if (group) {
      this.sessionGroups.delete(groupId);
      for (const [tabId, tab] of group.tabs) {
        this.destroyedTabs.add(tabId);
        try { tab.view.webContents.close(); } catch { /* ignore */ }
      }
    }
  }

  /** Zero-size rectangle used to hide inactive tabs (avoids removeChildView). */
  private static readonly HIDDEN_BOUNDS = { x: 0, y: 0, width: 0, height: 0 };

  /**
   * Create a new tab. Optionally navigate to a URL.
   * The new tab becomes the active tab.
   */
  createTab(url?: string): TabInfo {
    if (!this.mainWindow) throw new Error("TabManager not initialized");
    return this.createOwnedTab({
      groupId: this.currentGroupId,
      electronSession: this.activeElectronSession,
      url,
      activate: true,
    });
  }

  /**
   * Close a tab. If closing the last tab, create a new blank tab first.
   */
  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    const isLastTab = this.tabs.size <= 1;

    // If this is the last tab, create a replacement before closing
    if (isLastTab) {
      this.createTab();
    }

    // If closing the active tab, activate another one first
    if (this.activeTabId === tabId) {
      const tabIds = Array.from(this.tabs.keys());
      const idx = tabIds.indexOf(tabId);
      const nextId = tabIds[idx + 1] || tabIds[idx - 1];
      if (nextId) {
        this.activateTab(nextId);
      }
    }

    this.tabs.delete(tabId);
    this.destroyedTabs.add(tabId);

    // Now remove from window and destroy (only removeChildView on actual destruction)
    if (this.mainWindow) {
      try {
        this.mainWindow.contentView.removeChildView(tab.view);
      } catch { /* already removed */ }
    }
    try {
      tab.view.webContents.close();
    } catch { /* already destroyed */ }

    this.emit("tab-closed", { tabId, groupId: tab.groupId });
  }

  /**
   * Switch the active tab. Hides the old tab (zero bounds) and shows the new one.
   * Views are never removed/re-added — only bounds change — to avoid
   * blink.mojom.WidgetHost Mojo IPC crashes.
   */
  activateTab(tabId: string): void {
    if (!this.mainWindow) return;
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    // Hide the previous active tab by setting zero bounds
    if (this.activeTabId && this.activeTabId !== tabId) {
      const oldTab = this.tabs.get(this.activeTabId);
      if (oldTab) {
        try {
          oldTab.view.setBounds(TabManager.HIDDEN_BOUNDS);
        } catch { /* view destroyed */ }
      }
    }

    this.activeTabId = tabId;

    // Show the new tab with proper bounds (or hide if browser area is invisible)
    const shouldShow = this.visibilityChecker ? this.visibilityChecker() : true;
    if (shouldShow && this.boundsCalculator) {
      try {
        tab.view.setBounds(this.boundsCalculator());
      } catch { /* view may have been destroyed */ }
    } else {
      try {
        tab.view.setBounds(TabManager.HIDDEN_BOUNDS);
      } catch { /* view destroyed */ }
    }

    this.emit("tab-activated", {
      tabId,
      url: tab.url,
      title: tab.title,
      groupId: tab.groupId,
    });
  }

  /**
   * Update bounds on the active tab (e.g., on window resize).
   */
  updateBounds(): void {
    if (!this.activeTabId || !this.boundsCalculator) return;
    const tab = this.tabs.get(this.activeTabId);
    if (tab) {
      try {
        if (!tab.view.webContents.isDestroyed()) {
          tab.view.setBounds(this.boundsCalculator());
        }
      } catch { /* view destroyed */ }
    }
  }

  getActiveTab(): TabInfo | null {
    if (!this.activeTabId) return null;
    return this.tabs.get(this.activeTabId) || null;
  }

  getActiveWebContents(): WebContents | null {
    return this.getActiveTab()?.view.webContents || null;
  }

  getAllTabs(): TabInfo[] {
    return Array.from(this.tabs.values());
  }

  /** Mark manager as shutting down (disables tab auto-recreation paths). */
  setShuttingDown(shuttingDown: boolean): void {
    this.isShuttingDown = shuttingDown;
  }

  /** Set the Electron session used for new tabs (partition isolation). */
  setActiveElectronSession(s: ElectronSession | null): void {
    this.activeElectronSession = s;
  }

  /** Get the current session group ID. */
  getCurrentGroupId(): string | null {
    return this.currentGroupId;
  }

  /**
   * Destroy all tabs and clean up (current visible group only).
   */
  destroyAllTabs(): void {
    const tabs = [...this.tabs.entries()];
    this.tabs.clear();
    this.activeTabId = null;
    for (const [tabId, tab] of tabs) {
      this.destroyedTabs.add(tabId);
      if (this.mainWindow) {
        try { this.mainWindow.contentView.removeChildView(tab.view); } catch { /* ignore */ }
      }
      try { tab.view.webContents.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Destroy ALL tabs across ALL session groups (used on app quit).
   */
  destroyEverything(): void {
    this.destroyAllTabs();
    const groups = [...this.sessionGroups.values()];
    this.sessionGroups.clear();
    for (const group of groups) {
      for (const [tabId, tab] of group.tabs) {
        this.destroyedTabs.add(tabId);
        try { tab.view.webContents.close(); } catch { /* ignore */ }
      }
    }
  }

  // ---- Internal helpers ----

  /**
   * Remove ALL current-group tab views from the window.
   * Used when stashing a session group — those views will sit dormant and
   * must not remain as children (they belong to a different partition).
   */
  private detachAllViews(): void {
    if (!this.mainWindow) return;
    for (const [, tab] of this.tabs) {
      try {
        this.mainWindow.contentView.removeChildView(tab.view);
      } catch { /* not in view */ }
    }
  }

  private createOwnedTab(options: CreateOwnedTabOptions): TabInfo {
    if (!this.mainWindow) throw new Error("TabManager not initialized");
    const route = resolveOwnedTabMap(
      options.groupId,
      this.currentGroupId,
      this.tabs,
      this.sessionGroups,
    );
    if (!route) {
      throw new Error(`Browser Session group ${options.groupId ?? "default"} no longer exists`);
    }

    const inheritedPreferences = options.browserWindowOptions?.webPreferences ?? {};
    const view = new WebContentsView({
      webPreferences: {
        ...inheritedPreferences,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(__dirname, "../preload/target-preload.js"),
        ...(options.electronSession ? { session: options.electronSession } : {}),
      },
    });
    view.setBackgroundColor("#1a1a2e");

    const tab: TabInfo = {
      id: uuidv4(),
      view,
      groupId: options.groupId,
      ...(options.openerTabId ? { openerTabId: options.openerTabId } : {}),
      url: options.url ?? "",
      title: options.browserWindowOptions?.title || "New Tab",
      isLoading: false,
    };
    route.tabs.set(tab.id, tab);

    // Capture, stealth, and Electron internals legitimately exceed Node's default.
    view.webContents.setMaxListeners(30);
    view.setBounds(TabManager.HIDDEN_BOUNDS);
    if (route.isCurrent) {
      try {
        this.mainWindow.contentView.addChildView(view);
      } catch {
        // The main window may be closing.
      }
    }

    this.setupTabListeners(tab);
    if (options.activate) {
      if (route.isCurrent) {
        this.activateTab(tab.id);
      } else if (options.groupId !== null) {
        const group = this.sessionGroups.get(options.groupId);
        if (group) group.activeTabId = tab.id;
      }
    }

    // Hidden Session tabs are announced when their group is restored. Publishing
    // them now would insert them into the currently visible Session's tab strip.
    if (route.isCurrent) {
      this.emit("tab-created", {
        id: tab.id,
        url: tab.url,
        title: tab.title,
        groupId: tab.groupId,
        ...(options.openerTabId ? { openerTabId: options.openerTabId } : {}),
      });
    }

    if (options.url && (options.loadUrl ?? true)) {
      view.webContents.loadURL(options.url).catch(() => {
        // The normal did-fail-load path renders a useful error page.
      });
    }
    return tab;
  }

  private createPopupTab(
    opener: TabInfo,
    details: HandlerDetails,
    browserWindowOptions: BrowserWindowConstructorOptions,
  ): TabInfo {
    return this.createOwnedTab({
      groupId: opener.groupId,
      electronSession: opener.view.webContents.session,
      url: details.url,
      activate: details.disposition !== "background-tab",
      browserWindowOptions,
      openerTabId: opener.id,
      loadUrl: false,
    });
  }

  private handleNativeTabDestroyed(tab: TabInfo): void {
    if (this.destroyedTabs.has(tab.id)) return;
    const route = resolveOwnedTabMap(
      tab.groupId,
      this.currentGroupId,
      this.tabs,
      this.sessionGroups,
    );
    if (!route || route.tabs.get(tab.id) !== tab) return;

    const group = tab.groupId === null ? null : this.sessionGroups.get(tab.groupId);
    const wasActive = route.isCurrent
      ? this.activeTabId === tab.id
      : group?.activeTabId === tab.id;
    route.tabs.delete(tab.id);
    this.destroyedTabs.add(tab.id);

    if (route.isCurrent && this.mainWindow) {
      try {
        this.mainWindow.contentView.removeChildView(tab.view);
      } catch {
        // The native view may already have been detached.
      }
    }

    if (wasActive) {
      if (route.isCurrent) this.activeTabId = null;
      else if (group) group.activeTabId = null;
    }

    if (!this.isShuttingDown) {
      if (route.tabs.size === 0) {
        this.createOwnedTab({
          groupId: tab.groupId,
          electronSession: route.isCurrent
            ? this.activeElectronSession
            : group?.electronSession ?? null,
          activate: true,
        });
      } else if (wasActive) {
        const nextId = route.tabs.keys().next().value as string | undefined;
        if (nextId) {
          if (route.isCurrent) this.activateTab(nextId);
          else if (group) group.activeTabId = nextId;
        }
      }
    }

    // Close events are ID-based, so publishing a hidden close cannot mutate the
    // visible group; it does let capture/backend owners release tab resources.
    this.emit("tab-closed", {
      tabId: tab.id,
      groupId: tab.groupId,
      isCurrentGroup: route.isCurrent,
    });
  }

  private emitTabUpdated(
    tab: TabInfo,
    update: { url?: string; title?: string; isLoading?: boolean },
  ): void {
    if (tab.groupId !== this.currentGroupId || this.tabs.get(tab.id) !== tab) return;
    this.emit("tab-updated", {
      tabId: tab.id,
      groupId: tab.groupId,
      ...update,
    });
  }

  /**
   * Set up event listeners on a tab's WebContents.
   */
  private setupTabListeners(tab: TabInfo): void {
    const wc = tab.view.webContents;

    // Ignore a page's beforeunload veto when the app explicitly closes a tab.
    wc.on("will-prevent-unload", (event) => {
      // Ignore the veto and do not show the "Leave site?" dialog.
      event.preventDefault();
    });

    // Track loading state
    wc.on("did-start-loading", () => {
      if (wc.isDestroyed()) return;
      tab.isLoading = true;
      this.emitTabUpdated(tab, {
        url: tab.url,
        title: tab.title,
        isLoading: true,
      });
    });
    wc.on("did-stop-loading", () => {
      if (wc.isDestroyed()) return;
      tab.isLoading = false;
      this.emitTabUpdated(tab, {
        url: tab.url,
        title: tab.title,
        isLoading: false,
      });
    });

    // Handle page load failures — show inline error instead of white screen
    wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (wc.isDestroyed()) return;
      if (!isMainFrame) return; // Ignore sub-frame failures
      if (errorCode === -3) return; // ERR_ABORTED — user navigated away, not a real error

      // Sanitize values to prevent XSS in the error page
      const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const safeDesc = esc(errorDescription || "");
      const safeUrl = esc(validatedURL || "");
      // Encode the original URL for the retry button (safe inside a JS string literal)
      const retryUrl = JSON.stringify(validatedURL || "");

      const errorPage = `data:text/html;charset=utf-8,${encodeURIComponent(`
        <!DOCTYPE html><html><head><style>
          body { background: #1a1a2e; color: #a0a0b8; font-family: -apple-system, system-ui, sans-serif;
            display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .box { text-align: center; max-width: 420px; }
          h2 { color: #e0e0f0; margin-bottom: 8px; }
          code { background: #2a2a4a; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
          .url { word-break: break-all; color: #7a7a9a; font-size: 13px; margin-top: 12px; }
          button { margin-top: 16px; background: #3a3a6a; border: none; color: #e0e0f0; padding: 8px 20px;
            border-radius: 6px; cursor: pointer; font-size: 13px; }
          button:hover { background: #4a4a8a; }
        </style></head><body><div class="box">
          <h2>\u65E0\u6CD5\u52A0\u8F7D\u6B64\u9875\u9762</h2>
          <p><code>${errorCode}</code> ${safeDesc}</p>
          <p class="url">${safeUrl}</p>
          <button onclick="location.href=${retryUrl.replace(/"/g, '&quot;')}">\u91CD\u8BD5</button>
        </div></body></html>
      `)}`;
      wc.loadURL(errorPage).catch(() => {});
    });

    // Let Electron create a real child WebContents inside our view. Returning a
    // custom WebContents preserves opener, POST body, referrer, frameName, and
    // parsed window features; manually loading details.url would discard them.
    wc.setWindowOpenHandler((details) => {
      const owner = resolveOwnedTabMap(
        tab.groupId,
        this.currentGroupId,
        this.tabs,
        this.sessionGroups,
      );
      if (this.isShuttingDown || !owner || !owner.tabs.has(tab.id)) {
        return { action: "deny" };
      }
      return {
        action: "allow",
        outlivesOpener: false,
        createWindow: (browserWindowOptions) =>
          this.createPopupTab(tab, details, browserWindowOptions).view.webContents,
      };
    });

    // Track URL changes
    const onNavigate = (): void => {
      if (wc.isDestroyed()) return;
      tab.url = wc.getURL();
      this.emitTabUpdated(tab, {
        url: tab.url,
        title: tab.title,
      });
    };
    wc.on("did-navigate", onNavigate);
    wc.on("did-navigate-in-page", onNavigate);

    // Track title changes
    wc.on("page-title-updated", (_event, title) => {
      if (wc.isDestroyed()) return;
      tab.title = title;
      this.emitTabUpdated(tab, {
        url: tab.url,
        title: tab.title,
      });
    });

    // Handle renderer process crash (GPU OOM, heavy WebGL, etc.)
    // Without this, the dead webContents stays in the view tree and any
    // subsequent operation on it crashes the main process.
    wc.on("render-process-gone", (_event, details) => {
      if (this.isShuttingDown) return;
      const route = resolveOwnedTabMap(
        tab.groupId,
        this.currentGroupId,
        this.tabs,
        this.sessionGroups,
      );
      if (
        this.destroyedTabs.has(tab.id) ||
        !route ||
        route.tabs.get(tab.id) !== tab
      ) return;

      console.warn(`[TabManager] Renderer process gone for tab ${tab.id}: ${details.reason}`);

      // Show a crash recovery page by replacing the tab
      const crashUrl = tab.url;
      const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const safeUrl = esc(crashUrl);

      // Remove ownership before close(), whose destroyed event can fire inline.
      route.tabs.delete(tab.id);
      this.destroyedTabs.add(tab.id);
      const group = tab.groupId === null ? null : this.sessionGroups.get(tab.groupId);
      if (route.isCurrent && this.activeTabId === tab.id) this.activeTabId = null;
      else if (!route.isCurrent && group?.activeTabId === tab.id) group.activeTabId = null;
      if (route.isCurrent && this.mainWindow) {
        try { this.mainWindow.contentView.removeChildView(tab.view); } catch { /* already removed */ }
      }
      try { tab.view.webContents.close(); } catch { /* already dead */ }
      this.emit("tab-closed", {
        tabId: tab.id,
        groupId: tab.groupId,
        isCurrentGroup: route.isCurrent,
      });

      // Create a new tab with crash info page
      const crashPage = `data:text/html;charset=utf-8,${encodeURIComponent(`
        <!DOCTYPE html><html><head><style>
          body { background: #1a1a2e; color: #a0a0b8; font-family: -apple-system, system-ui, sans-serif;
            display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .box { text-align: center; max-width: 420px; }
          h2 { color: #e0e0f0; margin-bottom: 8px; }
          code { background: #2a2a4a; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
          .url { word-break: break-all; color: #7a7a9a; font-size: 13px; margin-top: 12px; }
          button { margin-top: 16px; background: #3a3a6a; border: none; color: #e0e0f0; padding: 8px 20px;
            border-radius: 6px; cursor: pointer; font-size: 13px; }
          button:hover { background: #4a4a8a; }
        </style></head><body><div class="box">
          <h2>\\u9875\\u9762\\u5D29\\u6E83\\u4E86</h2>
          <p>\\u8BE5\\u9875\\u9762\\u7684\\u6E32\\u67D3\\u8FDB\\u7A0B\\u5DF2\\u7EC8\\u6B62</p>
          <p class="url">${safeUrl}</p>
          <button onclick="location.href=${JSON.stringify(crashUrl).replace(/"/g, '&quot;')}">\\u91CD\\u65B0\\u52A0\\u8F7D</button>
        </div></body></html>
      `)}`;
      this.createOwnedTab({
        groupId: tab.groupId,
        electronSession: route.isCurrent
          ? this.activeElectronSession
          : group?.electronSession ?? null,
        url: crashPage,
        activate: true,
      });
    });

    // Script-created child windows are allowed to call window.close(). Route
    // cleanup through the tab's fixed owner group, even when another Session is
    // currently visible.
    wc.on("destroyed", () => {
      this.handleNativeTabDestroyed(tab);
    });
  }
}
