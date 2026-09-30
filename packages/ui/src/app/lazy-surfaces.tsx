import * as React from "react";
import { Spinner } from "@/components/ui/spinner";

// Lazy-loaded low-frequency surfaces. Auth, session sidebar/viewer, banners,
// and loading/error UI remain eager so critical paths stay fast.
export const LazyUserPreferencesPanel = React.lazy(() => import("@/components/UserPreferencesPanel").then((m) => ({ default: m.UserPreferencesPanel })));
export const LazyApiKeyManager = React.lazy(() => import("@/components/ApiKeyManager").then((m) => ({ default: m.ApiKeyManager })));
export const LazyRunnerTokenManager = React.lazy(() => import("@/components/RunnerTokenManager").then((m) => ({ default: m.RunnerTokenManager })));
export const LazyDeviceSetupScanner = React.lazy(() => import("@/components/DeviceSetupScanner").then((m) => ({ default: m.DeviceSetupScanner })));
export const LazyMobileSetupQR = React.lazy(() => import("@/components/MobileSetupQR").then((m) => ({ default: m.MobileSetupQR })));
export const LazyRunnerManager = React.lazy(() => import("@/components/RunnerManager").then((m) => ({ default: m.RunnerManager })));
export const LazyNewSessionWizardDialog = React.lazy(() => import("@/components/NewSessionWizardDialog").then((m) => ({ default: m.NewSessionWizardDialog })));
export const LazyHistoryCommandPalette = React.lazy(() => import("@/components/HistoryCommandPalette").then((m) => ({ default: m.HistoryCommandPalette })));
export const LazySessionAnalyzerBody = React.lazy(() => import("@/components/session-viewer/SessionAnalyzerPanel").then((m) => ({ default: m.SessionAnalyzerBody })));
export const LazyEventsRoutesPanel = React.lazy(() => import("@/components/events/EventsRoutesPanel").then((m) => ({ default: m.EventsRoutesPanel })));
export const LazyTerminalManager = React.lazy(() => import("@/components/TerminalManager").then((m) => ({ default: m.TerminalManager })));
export const LazyFileExplorer = React.lazy(() => import("@/components/FileExplorer").then((m) => ({ default: m.FileExplorer })));
export const LazyGitPanel = React.lazy(() => import("@/components/git").then((m) => ({ default: m.GitPanel })));
export const LazyChangePasswordDialog = React.lazy(() => import("@/components/ChangePasswordDialog").then((m) => ({ default: m.ChangePasswordDialog })));
export const LazyShortcutsDialog = React.lazy(() => import("@/components/ShortcutsDialog").then((m) => ({ default: m.ShortcutsDialog })));

/** Stable, accessible Suspense fallback for lazy panels. */
export function PanelFallback({ label }: { label?: string }) {
  return (
    <div className="flex h-full w-full min-h-[120px] items-center justify-center">
      <div className="flex flex-col items-center gap-2 text-muted-foreground">
        <Spinner className="size-5 text-primary/60" />
        {label && <span className="text-xs">{label}</span>}
      </div>
    </div>
  );
}
