import * as React from "react";
import { useMountOnFirstOpen } from "@/hooks/useMountOnFirstOpen";

/**
 * Open state for the App-level dialogs, sheets and full-screen surfaces
 * (preferences, API keys, runners, history, new session, password, shortcuts,
 * device-setup claim, session switcher, hidden-models manager).
 *
 * Lazily-loaded dialogs expose a `*Mounted` flag that flips on first open and
 * stays true so their close animation / state survives.
 */
export function useAppDialogs() {
  const [showPreferences, setShowPreferences] = React.useState(false);
  const [showApiKeys, setShowApiKeys] = React.useState(false);
  // The API-keys sheet is a hand-rolled overlay (not a Radix Dialog), so wire
  // Escape-to-close at the document level while it's open — a container-scoped
  // handler misses key events when focus is still on the trigger.
  React.useEffect(() => {
    if (!showApiKeys) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowApiKeys(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showApiKeys]);
  const [apiKeyVersion, setApiKeyVersion] = React.useState(0);
  const [setupClaimOpen, setSetupClaimOpen] = React.useState(false);
  const [setupClaimToken, setSetupClaimToken] = React.useState<string | null>(null);
  const [showRunners, setShowRunners] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const historyMounted = useMountOnFirstOpen(historyOpen);
  const [selectedRunnerId, setSelectedRunnerId] = React.useState<string | null>(null);
  const [runnerManagerInitialTab, setRunnerManagerInitialTab] = React.useState<"sessions" | "triggers">("sessions");

  // Open the device-setup scanner automatically when landing with ?t=<claim-token>
  // (the CLI QR deep-link). Capture the token so it can be pre-filled into the
  // scanner, then strip it from the URL so it isn't left in history/shared links.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("t");
    if (t) {
      setSetupClaimToken(t);
      setSetupClaimOpen(true);
      params.delete("t");
      const qs = params.toString();
      window.history.replaceState(
        {},
        "",
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
      );
    }
  }, []);

  const [newSessionOpen, setNewSessionOpen] = React.useState(false);
  const newSessionMounted = useMountOnFirstOpen(newSessionOpen);
  const [hiddenModelsOpen, setHiddenModelsOpen] = React.useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = React.useState(false);
  const changePasswordMounted = useMountOnFirstOpen(changePasswordOpen);
  const [showShortcutsHelp, setShowShortcutsHelp] = React.useState(false);
  const shortcutsMounted = useMountOnFirstOpen(showShortcutsHelp);
  const [sessionSwitcherOpen, setSessionSwitcherOpen] = React.useState(false);

  return {
    showPreferences, setShowPreferences,
    showApiKeys, setShowApiKeys,
    apiKeyVersion, setApiKeyVersion,
    setupClaimOpen, setSetupClaimOpen,
    setupClaimToken,
    showRunners, setShowRunners,
    historyOpen, setHistoryOpen, historyMounted,
    selectedRunnerId, setSelectedRunnerId,
    runnerManagerInitialTab, setRunnerManagerInitialTab,
    newSessionOpen, setNewSessionOpen, newSessionMounted,
    hiddenModelsOpen, setHiddenModelsOpen,
    changePasswordOpen, setChangePasswordOpen, changePasswordMounted,
    showShortcutsHelp, setShowShortcutsHelp, shortcutsMounted,
    sessionSwitcherOpen, setSessionSwitcherOpen,
  };
}
