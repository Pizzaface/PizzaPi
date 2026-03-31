export function shouldShowViewerEventsDebugPage(pathname: string, debugViewEnabled: boolean): boolean {
  if (!debugViewEnabled) return false;
  return pathname.replace(/\/+$/, "") === "/debug/viewer-events";
}
