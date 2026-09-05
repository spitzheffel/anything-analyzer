import type { BrowserBackendKind } from "./types";

export function shouldShowEmbeddedBrowser(
  activeView: string,
  backend: BrowserBackendKind | null | undefined,
): boolean {
  return activeView === "browser" && backend === "electron";
}
