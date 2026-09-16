import type { BrowserBackendKind, CloakRuntimeStatus } from "./types";

export function shouldShowEmbeddedBrowser(
  activeView: string,
  backend: BrowserBackendKind | null | undefined,
): boolean {
  return activeView === "browser" && backend === "electron";
}

export interface CloakVersionDrift {
  requested: string;
  actual: string;
}

/**
 * The gap between the browser version strict mode asked for and the one
 * CloakBrowser actually resolved.
 *
 * Strict mode only *requests* a pin: the wrapper drops it on free plans, where
 * the server force-serves the latest kernel. That binary launches fine, so this
 * is reported rather than enforced — but the Session records the resolved
 * version, so a moved kernel means the browser contract tests have to run again.
 *
 * Only meaningful once the runtime is ready: until then the reported version is
 * still an echo of the request, not the resolution.
 */
export function cloakVersionDrift(
  status: CloakRuntimeStatus | null | undefined,
): CloakVersionDrift | null {
  if (!status || status.state !== "ready") return null;
  const { configuredVersion, actualVersion } = status;
  if (!configuredVersion || !actualVersion) return null;
  if (configuredVersion === actualVersion) return null;
  return { requested: configuredVersion, actual: actualVersion };
}
