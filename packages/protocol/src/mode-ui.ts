// ============================================================================
// Session mode UI resolution
//
// Turns a mode's declarative `ui` block into the concrete flags the web UI
// renders from. Modes declare intent; this module decides what that means.
// Kept in @pizzapi/protocol so the UI, the daemon and tests share one answer.
// ============================================================================

import type { ServiceModeDef, ServiceModeSuggestion, ServiceModeUi } from "./shared.js";

/** Fully-resolved UI configuration for a session mode. */
export interface ResolvedModeUi {
  /** Show the git panel/button. */
  git: boolean;
  /** Show the terminal affordance. */
  terminal: boolean;
  /** Show the process/shell panel. */
  processes: boolean;
  /** Render file edits as diffs. */
  diffs: boolean;
  /** Show the file explorer. */
  files: boolean;
  /** Transcript tool-call rendering style. */
  toolRendering: "detailed" | "activity";
  /** Singular noun for a session in this mode. */
  sessionNoun: string;
  /** Plural noun for sessions in this mode. */
  sessionNounPlural: string;
  /** Label for the new-session action. */
  newSessionLabel: string;
  /** Accent color token/hex, or null when the mode does not theme itself. */
  accent: string | null;
  /** Composer placeholder text, or null to use the app default. */
  composerPlaceholder: string | null;
  /** Headline for the mode home, or null. */
  greeting: string | null;
  /** Suggestion chips for the mode home. */
  suggestions: ServiceModeSuggestion[];
  /** Show the recent-sessions list on the mode home. */
  recent: boolean;
  /** Artifact cards + artifacts panel enabled. */
  artifacts: boolean;
  /** Extensions (lowercase, no dot) treated as deliverables. */
  artifactExtensions: string[];
  /** Show the scheduled-instructions surface. */
  scheduled: boolean;
}

/** Chrome defaults per preset. */
const PRESET_CHROME = {
  coding: { git: true, terminal: true, processes: true, diffs: true, files: true },
  work: { git: false, terminal: false, processes: false, diffs: false, files: true },
} as const;

/**
 * Deliverable extensions assumed when a mode enables artifacts without
 * naming any. Document-centric: the things a knowledge-work mode produces.
 */
export const DEFAULT_ARTIFACT_EXTENSIONS = [
  "md",
  "html",
  "pdf",
  "csv",
  "xlsx",
  "docx",
  "pptx",
  "png",
  "jpg",
  "jpeg",
  "svg",
  "json",
] as const;

/**
 * Resolve a mode's declarative UI block into concrete flags.
 *
 * `undefined` (no mode / no `ui`) yields today's coding-agent UI, so sessions
 * outside a mode and modes that predate this contract are unchanged.
 */
export function resolveModeUi(mode?: ServiceModeDef | null): ResolvedModeUi {
  const ui: ServiceModeUi = mode?.ui ?? {};
  const preset = ui.preset === "work" ? "work" : "coding";
  const presetChrome = PRESET_CHROME[preset];
  const chrome = ui.chrome ?? {};
  const vocabulary = ui.vocabulary ?? {};
  const home = ui.home ?? {};
  const artifacts = ui.artifacts;

  const sessionNoun = vocabulary.session ?? "session";
  const sessionNounPlural = vocabulary.sessions ?? `${sessionNoun}s`;

  const extensions = artifacts?.extensions?.length
    ? artifacts.extensions.map((ext) => ext.replace(/^\./, "").toLowerCase())
    : [...DEFAULT_ARTIFACT_EXTENSIONS];

  return {
    git: chrome.git ?? presetChrome.git,
    terminal: chrome.terminal ?? presetChrome.terminal,
    processes: chrome.processes ?? presetChrome.processes,
    diffs: chrome.diffs ?? presetChrome.diffs,
    files: chrome.files ?? presetChrome.files,
    toolRendering: ui.toolRendering ?? (preset === "work" ? "activity" : "detailed"),
    sessionNoun,
    sessionNounPlural,
    newSessionLabel: vocabulary.newSession ?? `New ${sessionNoun}`,
    accent: ui.accent ?? null,
    composerPlaceholder: ui.composerPlaceholder ?? null,
    greeting: home.greeting ?? null,
    suggestions: home.suggestions ?? [],
    recent: home.recent ?? true,
    artifacts: artifacts?.enabled ?? false,
    artifactExtensions: extensions,
    scheduled: ui.scheduled ?? false,
  };
}

/** True when `path` looks like a deliverable for the given resolved mode. */
export function isArtifactPath(path: string, resolved: ResolvedModeUi): boolean {
  if (!resolved.artifacts) return false;
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  if (!match) return false;
  return resolved.artifactExtensions.includes(match[1]!.toLowerCase());
}

/**
 * True when `cwd` is the mode workspace or lives inside it.
 *
 * Boundary-aware: `~/Workspace` must not claim `~/Workspace-old`.
 * Trailing slashes on the workspace are tolerated so a manifest that writes
 * `~/Documents/Workspace/` behaves the same as one that does not.
 */
export function cwdInWorkspace(cwd: string, workspace: string): boolean {
  // ponytail: loop, not /\/+$/ — that regex backtracks on many trailing slashes (CodeQL js/polynomial-redos)
  let root = workspace;
  while (root.endsWith("/")) root = root.slice(0, -1);
  if (!root) return false;
  return cwd === root || cwd.startsWith(`${root}/`);
}

/**
 * Find the mode a session belongs to, by workspace containment.
 *
 * Containment (not spawn-time stamping) is deliberate: a session started
 * outside the web UI — `cd ~/Documents/Workspace && pizza` — carries no stamp
 * but is unambiguously in that mode. Deepest workspace wins so nested mode
 * workspaces resolve to the most specific mode.
 */
/**
 * Whether a mode-scoped service surface (panel, trigger def) should be shown
 * for a session in `activeMode`. Surfaces with no `modes` list are visible
 * everywhere; scoped surfaces require the session's mode id to match.
 */
export function surfaceVisibleInMode(
  surfaceModes: string[] | undefined,
  activeMode: { id: string } | null | undefined,
): boolean {
  if (!surfaceModes || surfaceModes.length === 0) return true;
  return !!activeMode && surfaceModes.includes(activeMode.id);
}

export function findSessionMode(
  session: { cwd?: string | null; runnerId?: string | null } | null | undefined,
  modes: ServiceModeDef[],
  modesRunnerId?: string | null,
): ServiceModeDef | null {
  if (!session?.cwd || modes.length === 0) return null;
  // A mode belongs to the runner that announced it; never apply another
  // runner's mode to a session just because the paths line up. A session with
  // no runner (local/relay-only) cannot be shown to be on that runner, so it
  // does not qualify either — paths are only meaningful per machine.
  if (modesRunnerId && session.runnerId !== modesRunnerId) return null;
  const cwd = session.cwd;
  let best: ServiceModeDef | null = null;
  for (const mode of modes) {
    if (!cwdInWorkspace(cwd, mode.workspace)) continue;
    if (!best || mode.workspace.length > best.workspace.length) best = mode;
  }
  return best;
}
