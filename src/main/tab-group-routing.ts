export interface RoutedTabMap<T> {
  tabs: Map<string, T>;
  isCurrent: boolean;
}

/** Resolve a tab's immutable owner group without consulting current UI state. */
export function resolveOwnedTabMap<T>(
  ownerGroupId: string | null,
  currentGroupId: string | null,
  currentTabs: Map<string, T>,
  storedGroups: ReadonlyMap<string, { tabs: Map<string, T> }>,
): RoutedTabMap<T> | null {
  if (ownerGroupId === currentGroupId) {
    return { tabs: currentTabs, isCurrent: true };
  }
  if (ownerGroupId === null) return null;
  const stored = storedGroups.get(ownerGroupId);
  return stored ? { tabs: stored.tabs, isCurrent: false } : null;
}
