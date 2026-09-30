import * as React from "react";
import type { ServicePanelInfo } from "@pizzapi/protocol";
import { findSessionMode, resolveModeUi, surfaceVisibleInMode } from "@pizzapi/protocol";
import type { HubSession } from "@/components/SessionSidebar";
import { fetchScheduledInstructions, type ScheduledInstruction } from "@/components/session-viewer/ModeSchedule";
import { resolveLauncherSource } from "@/utils/servicePanelUtils";
import { mapUserError } from "@/lib/user-error-message";
import type { UseSessionLifecycleResult } from "@/lib/use-session-lifecycle";
import type { useRunnersFeed } from "@/lib/useRunnersFeed";
import type { useRunnerData } from "@/hooks/useRunnerData";
import type { StateSetter } from "./types";

type FeedRunner = ReturnType<typeof useRunnersFeed>["runners"][number];

export interface ModeHomeOptions {
  feedRunners: FeedRunner[];
  activeRunnerInfo: ReturnType<typeof useRunnerData>;
  activeSessionInfo: { runnerId: string | null; cwd: string } | null;
  liveSessions: HubSession[];
  dynamicPanels: ServicePanelInfo[];
  availableServices: Set<string>;
  selectedRunnerId: string | null;
  lifecycleSpawnSession: UseSessionLifecycleResult["spawnSession"];
  setLifecycleStatus: UseSessionLifecycleResult["setStatus"];
  handleOpenSession: (id: string) => void;
  setShowGit: StateSetter<boolean>;
  setShowTerminal: StateSetter<boolean>;
  setShowFileExplorer: StateSetter<boolean>;
}

/**
 * Session modes (runner-declared UI profiles): which mode the active session
 * is in and the resulting `modeUi`, mode-scoped service panels, the sidebar
 * mode selection with its "mode home" (recent sessions, scheduled work, start
 * task), and session-list launcher panels.
 */
export function useModeHome(options: ModeHomeOptions) {
  const {
    feedRunners,
    activeRunnerInfo,
    activeSessionInfo,
    liveSessions,
    dynamicPanels,
    availableServices,
    selectedRunnerId,
    lifecycleSpawnSession,
    setLifecycleStatus,
    handleOpenSession,
    setShowGit,
    setShowTerminal,
    setShowFileExplorer,
  } = options;

  // Modes come from the active session's runner, but the mode home exists for
  // when nothing is open — so with no active session fall back to a connected
  // runner that declares modes, or the picker never appears.
  // Modes and their owning runner are read from the SAME runner object. Taking
  // the modes from one source and the runner id from another means a
  // cross-runner switch can briefly pair the old runner's modes with the new
  // runner's id — and a mode that hides chrome closes those panels for good.
  const modesSource = React.useMemo(() => {
    // Prefer the active session's runner, but only when it actually declares
    // modes — otherwise the mode list and mode home vanish the moment you open
    // a session on a modeless runner (a subagent child, a plain coding runner).
    // Modes and their owning runner id are still read from the SAME runner
    // object, so a cross-runner switch can't pair one runner's modes with
    // another's id. activeMode stays correct because findSessionMode requires
    // the session's own runnerId to match modesSource.runnerId — a session on a
    // modeless runner resolves to no mode (standard UI) even while the fallback
    // runner's modes keep showing in the sidebar.
    if (activeRunnerInfo && (activeRunnerInfo.sessionModes?.length ?? 0) > 0) {
      return { modes: activeRunnerInfo.sessionModes ?? [], runnerId: activeRunnerInfo.runnerId };
    }
    const runner = feedRunners.find((candidate) => (candidate.sessionModes?.length ?? 0) > 0);
    return { modes: runner?.sessionModes ?? [], runnerId: runner?.runnerId ?? null };
  }, [activeRunnerInfo, feedRunners]);
  const effectiveSessionModes = modesSource.modes;

  // The mode the active session belongs to, and what that mode says the UI
  // should look like. No mode (or a mode without a `ui` block) resolves to the
  // standard coding UI, so this is inert for every existing session.
  // Compared against the runner that ANNOUNCED the modes, not the session's own
  // runner — otherwise the check compares a value to itself and always passes,
  // letting one runner's mode style another runner's identically-pathed session.
  const activeMode = React.useMemo(
    () => findSessionMode(activeSessionInfo, effectiveSessionModes, modesSource.runnerId),
    [activeSessionInfo, effectiveSessionModes, modesSource.runnerId],
  );
  const modeUi = React.useMemo(() => resolveModeUi(activeMode), [activeMode]);

  // Mode-scoped service surfaces: a service declaring `modes` in its overlay
  // only shows its panel/triggers for sessions inside a matching mode. Sigil
  // defs stay unfiltered so existing [[type:id]] sigils render everywhere.
  const modePanels = React.useMemo(
    () => dynamicPanels.filter((p) => surfaceVisibleInMode(p.modes, activeMode)),
    [dynamicPanels, activeMode],
  );

  // Session-list launchers hang off the session list, not a session, so they
  // read panels from the runner feed when nothing is open (no active session =
  // no active runner = no announced panels).
  const launcherSource = React.useMemo(
    () => resolveLauncherSource(dynamicPanels, activeRunnerInfo?.runnerId ?? null, feedRunners, selectedRunnerId),
    [dynamicPanels, activeRunnerInfo?.runnerId, feedRunners, selectedRunnerId],
  );

  // Mode selected in the sidebar, which drives the mode home shown when no
  // session is open. Independent of the active session's own mode.
  const [selectedModeId, setSelectedModeId] = React.useState<string | null>(null);
  const selectedMode = React.useMemo(
    () => effectiveSessionModes.find((mode) => mode.id === selectedModeId) ?? null,
    [effectiveSessionModes, selectedModeId],
  );
  const selectedModeUi = React.useMemo(() => resolveModeUi(selectedMode), [selectedMode]);
  const [startingTask, setStartingTask] = React.useState(false);

  // Session-list launcher panel state — full-screen managers declared by
  // runner services via panel.launcher (e.g. PizzaWork Schedules).
  const [openLauncherPanelId, setOpenLauncherPanelId] = React.useState<string | null>(null);
  const handleOpenLauncherPanel = React.useCallback((panel: ServicePanelInfo) => {
    setOpenLauncherPanelId((prev) => (prev === panel.serviceId ? null : panel.serviceId));
  }, []);
  const handleCloseLauncherPanel = React.useCallback(() => {
    setOpenLauncherPanelId(null);
  }, []);

  /** Every session in the selected mode, newest first. */
  const selectedModeAllSessions = React.useMemo(() => {
    if (!selectedMode) return [];
    return liveSessions
      .filter((session) => findSessionMode(session, effectiveSessionModes, modesSource.runnerId)?.id === selectedMode.id)
      .slice()
      .sort((a, b) => Date.parse(b.lastHeartbeatAt ?? b.startedAt) - Date.parse(a.lastHeartbeatAt ?? a.startedAt));
  }, [liveSessions, selectedMode, effectiveSessionModes, modesSource.runnerId]);

  /** The handful shown under "Recent" — display only, never the search scope. */
  const selectedModeSessions = React.useMemo(() => selectedModeAllSessions.slice(0, 5), [selectedModeAllSessions]);

  // Standing scheduled work for the selected mode.
  //
  // Schedules belong to a RUNNER and outlive the sessions that create them, so
  // they are fetched per runner and then placed into a mode by workspace. The
  // previous per-session fan-out could only see a schedule whose owning session
  // was in the page of sessions being listed, so old and ownerless schedules
  // silently vanished from the surface meant to cancel them.
  const [scheduledInstructions, setScheduledInstructions] = React.useState<ScheduledInstruction[]>([]);
  const [scheduledLoading, setScheduledLoading] = React.useState(false);
  const [scheduledFailed, setScheduledFailed] = React.useState(0);
  const wantsSchedule = !!selectedMode && selectedModeUi.scheduled;
  const scheduleRunnerId = modesSource.runnerId ?? null;

  const reloadScheduled = React.useCallback((signal?: AbortSignal) => {
    if (!wantsSchedule || !scheduleRunnerId || !selectedMode) {
      setScheduledInstructions([]);
      setScheduledFailed(0);
      // Clear here too: an aborted in-flight load skips its own finally, so
      // without this the home can sit on "Checking scheduled work" forever.
      setScheduledLoading(false);
      return Promise.resolve();
    }
    setScheduledLoading(true);
    return fetchScheduledInstructions(scheduleRunnerId, signal)
      .then(({ instructions, failed }) => {
        if (signal?.aborted) return;
        setScheduledInstructions(instructions);
        setScheduledFailed(failed);
      })
      .catch((err) => { if (!signal?.aborted) console.error("Failed to load scheduled work:", err); })
      .finally(() => { if (!signal?.aborted) setScheduledLoading(false); });
    // Deliberately depends only on WHAT to fetch, never on mode-shape values.
    // modesSource derives from the runners feed, so its identity changes on
    // every heartbeat — depending on it here re-ran the fetch (and replaced
    // state with a fresh array) on every tick, thrashing the app.
  }, [wantsSchedule, scheduleRunnerId, selectedMode?.id]);

  // Placing a schedule in a mode is pure derivation, so it belongs here rather
  // than in the fetch. A schedule whose workspace is unknown is kept rather
  // than dropped: losing sight of one is worse than showing it in the wrong
  // mode, since this is the only surface that can cancel it.
  const visibleScheduledInstructions = React.useMemo(() => {
    if (!selectedMode) return [];
    return scheduledInstructions.filter((instruction) => {
      if (!instruction.cwd) return true;
      return findSessionMode(
        { cwd: instruction.cwd, runnerId: scheduleRunnerId },
        effectiveSessionModes,
        modesSource.runnerId,
      )?.id === selectedMode.id;
    });
  }, [scheduledInstructions, selectedMode, effectiveSessionModes, modesSource.runnerId, scheduleRunnerId]);

  React.useEffect(() => {
    const controller = new AbortController();
    void reloadScheduled(controller.signal);
    return () => controller.abort();
  }, [reloadScheduled]);

  /** Start a task in the selected mode's workspace with the composed prompt. */
  // `startingTask` state lands a render too late to stop a double submit, so a
  // ref gates the second caller synchronously.
  const startingTaskRef = React.useRef(false);
  const handleStartModeTask = React.useCallback(async (prompt: string) => {
    if (!selectedMode || startingTaskRef.current) return;
    // The mode's workspace only exists on the runner that announced it, so the
    // task must start there — never on whichever runner happens to be first.
    const runnerId = modesSource.runnerId;
    if (!runnerId) {
      setLifecycleStatus("No runner available to start this task");
      return;
    }
    startingTaskRef.current = true;
    setStartingTask(true);
    try {
      const sessionId = await lifecycleSpawnSession(runnerId, selectedMode.workspace, undefined, { prompt });
      handleOpenSession(sessionId);
    } catch (err) {
      const mapped = mapUserError({ error: err, context: "session_spawn" });
      console.error("Failed to start mode task:", err);
      setLifecycleStatus(mapped.userMessage);
    } finally {
      startingTaskRef.current = false;
      setStartingTask(false);
    }
  }, [selectedMode, modesSource.runnerId, lifecycleSpawnSession, handleOpenSession, setLifecycleStatus]);

  // Hiding a surface has to close it too: switching from a coding session to a
  // Work task with the git panel open would otherwise strand a panel the mode
  // says does not exist, with no button left to close it.
  React.useEffect(() => {
    if (!modeUi.git) setShowGit(false);
    if (!modeUi.terminal) setShowTerminal(false);
    if (!modeUi.files) setShowFileExplorer(false);
  }, [modeUi.git, modeUi.terminal, modeUi.files, setShowGit, setShowTerminal, setShowFileExplorer]);

  // The same surfaces also exist as service panels. Filtering them here both
  // hides their buttons and feeds the "close panels that went away" effect
  // below, so a hidden panel cannot stay open.
  const modeVisibleServices = React.useMemo(() => {
    const hidden = new Set<string>();
    if (!modeUi.git) hidden.add("git");
    if (!modeUi.terminal) hidden.add("terminal");
    if (!modeUi.files) hidden.add("file-explorer");
    if (!modeUi.processes) hidden.add("process");
    if (hidden.size === 0) return availableServices;
    return new Set([...availableServices].filter((id) => !hidden.has(id)));
  }, [availableServices, modeUi.git, modeUi.terminal, modeUi.files, modeUi.processes]);

  return {
    modesSource,
    effectiveSessionModes,
    activeMode,
    modeUi,
    modePanels,
    launcherSource,
    selectedModeId,
    setSelectedModeId,
    selectedMode,
    selectedModeUi,
    startingTask,
    openLauncherPanelId,
    handleOpenLauncherPanel,
    handleCloseLauncherPanel,
    selectedModeSessions,
    visibleScheduledInstructions,
    scheduledLoading,
    scheduledFailed,
    scheduleRunnerId,
    handleStartModeTask,
    modeVisibleServices,
  };
}
