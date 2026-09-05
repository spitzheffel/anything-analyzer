import { useState, useEffect, useCallback, useRef } from "react";
import type {
  BrowserTab,
  BrowserTabActivatedEvent,
  BrowserTabEventScope,
  BrowserTabsResetEvent,
  BrowserTabUpdatedEvent,
} from "@shared/types";

export interface UseTabsReturn {
  tabs: BrowserTab[];
  activeTabId: string | null;
  activeTabUrl: string;
  isActiveTabLoading: boolean;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  createTab: (url?: string) => void;
}

/**
 * useTabs — React hook for managing browser tab state.
 * Synchronizes with the main process TabManager via IPC events.
 */
export function useTabs(): UseTabsReturn {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const activeScope = useRef<{ sessionId: string; contextId: string } | null>(null);

  // Derive active tab URL
  const activeTabUrl = tabs.find((t) => t.id === activeTabId)?.url || "";
  const isActiveTabLoading = tabs.find((t) => t.id === activeTabId)?.isLoading || false;

  // Load initial tab state
  useEffect(() => {
    window.electronAPI.listTabs().then((initialTabs) => {
      const first = initialTabs[0];
      if (
        first &&
        activeScope.current &&
        (first.sessionId !== activeScope.current.sessionId ||
          first.contextId !== activeScope.current.contextId)
      ) {
        return;
      }
      if (first) {
        activeScope.current = {
          sessionId: first.sessionId,
          contextId: first.contextId,
        };
      }
      setTabs(initialTabs);
      const active = initialTabs.find((t) => t.isActive);
      if (active) setActiveTabId(active.id);
    });
  }, []);

  // Listen for tab events from main process
  useEffect(() => {
    const isCurrentScope = (scope: BrowserTabEventScope): boolean =>
      activeScope.current?.sessionId === scope.sessionId &&
      activeScope.current?.contextId === scope.contextId;

    window.electronAPI.onTabsReset((event: BrowserTabsResetEvent) => {
      activeScope.current = event.sessionId && event.contextId
        ? { sessionId: event.sessionId, contextId: event.contextId }
        : null;
      setTabs(event.tabs);
      setActiveTabId(event.tabs.find((tab) => tab.isActive)?.id ?? null);
    });

    window.electronAPI.onTabCreated((tab: BrowserTab) => {
      if (activeScope.current && !isCurrentScope(tab)) return;
      activeScope.current = { sessionId: tab.sessionId, contextId: tab.contextId };
      setTabs((prev) => {
        // Avoid duplicates
        if (prev.some((t) => t.id === tab.id)) return prev;
        return [
          ...prev.map((t) => ({ ...t, isActive: false })),
          { ...tab, isActive: true },
        ];
      });
      setActiveTabId(tab.id);
    });

    window.electronAPI.onTabClosed((data: BrowserTabEventScope) => {
      if (!isCurrentScope(data)) return;
      setTabs((prev) => prev.filter((t) => t.id !== data.tabId));
      setActiveTabId((prev) => (prev === data.tabId ? null : prev));
    });

    window.electronAPI.onTabActivated(
      (data: BrowserTabActivatedEvent) => {
        if (!isCurrentScope(data)) return;
        setTabs((prev) =>
          prev.map((t) => ({
            ...t,
            isActive: t.id === data.tabId,
          })),
        );
        setActiveTabId(data.tabId);
      },
    );

    window.electronAPI.onTabUpdated(
      (data: BrowserTabUpdatedEvent) => {
        if (!isCurrentScope(data)) return;
        setTabs((prev) =>
          prev.map((t) => {
            if (t.id !== data.tabId) return t;
            return {
              ...t,
              url: data.url ?? t.url,
              title: data.title ?? t.title,
              isLoading: data.isLoading ?? t.isLoading,
            };
          }),
        );
      },
    );

    return () => {
      window.electronAPI.removeAllListeners("tabs:created");
      window.electronAPI.removeAllListeners("tabs:closed");
      window.electronAPI.removeAllListeners("tabs:activated");
      window.electronAPI.removeAllListeners("tabs:updated");
      window.electronAPI.removeAllListeners("tabs:reset");
    };
  }, []);

  const activateTab = useCallback((tabId: string) => {
    window.electronAPI.activateTab(tabId);
  }, []);

  const closeTab = useCallback((tabId: string) => {
    window.electronAPI.closeTab(tabId);
  }, []);

  const createTab = useCallback((url?: string) => {
    window.electronAPI.createTab(url);
  }, []);

  return { tabs, activeTabId, activeTabUrl, isActiveTabLoading, activateTab, closeTab, createTab };
}
