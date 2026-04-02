/**
 * Memoized header components extracted from App.tsx.
 *
 * By isolating the headers behind React.memo, they skip re-renders when only
 * session-scoped state changes (messages, agentActive, todoList, etc.).
 * Runner-scoped state (providerUsage, authSource, availableModels) is preserved
 * on same-runner session switches, so these props stay referentially stable
 * and the headers genuinely avoid re-rendering.
 */
import * as React from "react";
import { PizzaLogo } from "@/components/PizzaLogo";
import { ProviderIcon } from "@/components/ProviderIcon";
import { UsageIndicator, type ProviderUsageMap } from "@/components/UsageIndicator";
import { NotificationToggle } from "@/components/NotificationToggle";
import { HapticsToggle } from "@/components/HapticsToggle";
import { Button } from "@/components/ui/button";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DotState, HubSession } from "@/components/SessionSidebar";
import type { ConfiguredModelInfo } from "@/lib/types";
import {
  Sun, Moon, Monitor, LogOut, KeyRound, User, ChevronsUpDown, PanelLeftOpen, HardDrive,
  Keyboard, Lock, Check, Plus, Settings, Clock,
} from "lucide-react";
import { signOut } from "@/lib/auth-client";
import { useTheme, type ThemeMode } from "@/components/ThemeProvider";

const THEME_CYCLE: ThemeMode[] = ["auto", "light", "dark"];
const THEME_ICON: Record<ThemeMode, React.ReactNode> = {
  auto: <Monitor className="h-4 w-4" />,
  light: <Sun className="h-4 w-4" />,
  dark: <Moon className="h-4 w-4" />,
};
const THEME_LABEL: Record<ThemeMode, string> = { auto: "Auto", light: "Light", dark: "Dark" };

function ThemeToggleButton() {
  const { mode, setMode } = useTheme();
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(mode) + 1) % THEME_CYCLE.length];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          onClick={() => setMode(next)}
          aria-label={`Theme: ${THEME_LABEL[mode]}`}
        >
          {THEME_ICON[mode]}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Theme: {THEME_LABEL[mode]}</TooltipContent>
    </Tooltip>
  );
}

function ThemeMenuItems() {
  const { mode, setMode } = useTheme();
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(mode) + 1) % THEME_CYCLE.length];
  return (
    <DropdownMenuItem onSelect={() => setMode(next)}>
      {THEME_ICON[mode]}
      Theme: {THEME_LABEL[mode]}
    </DropdownMenuItem>
  );
}

// ── Shared helpers ──────────────────────────────────────────────────────────

export function relayStatusLabel(status: DotState, short = false) {
  if (status === "connected") return short ? "Connected" : "Relay connected";
  if (status === "connecting") return "Connecting…";
  return short ? "Disconnected" : "Relay disconnected";
}

export function relayStatusDot(status: DotState) {
  return `inline-block h-2 w-2 rounded-full ${status === "connected" ? "bg-green-500 shadow-[0_0_4px_#22c55e80]" : status === "connecting" ? "bg-slate-400" : "bg-red-500"}`;
}

export function initials(value: string) {
  const parts = value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase()).join("") || "U";
}

// ── Desktop header ──────────────────────────────────────────────────────────

export interface DesktopHeaderProps {
  relayStatus: DotState;
  providerUsage: ProviderUsageMap | null;
  authSource: string | null;
  activeProvider: string | undefined;
  usageRefreshing: boolean;
  userName: string;
  userEmail: string;
  userLabel: string;
  onShowPreferences: () => void;
  onShowApiKeys: () => void;
  onShowRunners: () => void;
  onShowShortcuts: () => void;
  onChangePassword: () => void;
  onRefreshUsage: () => boolean | void;
  onShowHistory?: () => void;
}

export const DesktopHeader = React.memo(function DesktopHeader({
  relayStatus,
  providerUsage,
  authSource,
  activeProvider,
  usageRefreshing,
  userName,
  userEmail,
  userLabel,
  onShowPreferences,
  onShowApiKeys,
  onShowRunners,
  onShowShortcuts,
  onChangePassword,
  onRefreshUsage,
  onShowHistory,
}: DesktopHeaderProps) {
  return (
    <header className="hidden md:flex items-center justify-between gap-3 border-b bg-background px-4 pb-2 pt-[calc(0.5rem_+_env(safe-area-inset-top))] flex-shrink-0">
      <div className="flex items-center gap-3 flex-shrink-0">
        <PizzaLogo />
        <span className="text-sm font-semibold">PizzaPi</span>
        <Separator orientation="vertical" className="h-5" />
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={relayStatusDot(relayStatus)} />
          <span>{relayStatusLabel(relayStatus)}</span>
        </div>
        {(providerUsage || authSource) && (
          <>
            <Separator orientation="vertical" className="h-5" />
            <UsageIndicator
              usage={providerUsage}
              authSource={authSource}
              activeProvider={activeProvider}
              onRefresh={onRefreshUsage}
              refreshing={usageRefreshing}
            />
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        {onShowHistory && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={onShowHistory}
                aria-label="Session history"
              >
                <Clock className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Session history (⌘⇧H)</TooltipContent>
          </Tooltip>
        )}

        <ThemeToggleButton />

        <NotificationToggle />
        <HapticsToggle />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={onShowApiKeys}
              aria-label="Manage API keys"
            >
              <KeyRound className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Manage API keys</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={onShowShortcuts}
              aria-label="Keyboard shortcuts"
            >
              <Keyboard className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Keyboard shortcuts (?)</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[11px] font-semibold flex-shrink-0">
                {initials(userLabel)}
              </span>
              <span className="truncate text-left max-w-40">{userLabel}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              <span className="truncate">{userName || "Signed in"}</span>
            </DropdownMenuLabel>
            {userEmail && (
              <div className="px-2 pb-1 text-xs text-muted-foreground truncate">{userEmail}</div>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onShowPreferences}>
              <Settings className="h-4 w-4" />
              Preferences
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onShowApiKeys}>
              <KeyRound className="h-4 w-4" />
              API keys
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onShowRunners}>
              <HardDrive className="h-4 w-4" />
              Runners
            </DropdownMenuItem>
            {onShowHistory && (
              <DropdownMenuItem onSelect={onShowHistory}>
                <Clock className="h-4 w-4" />
                Session history
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={onChangePassword}>
              <Lock className="h-4 w-4" />
              Change password
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => signOut()}>
              <LogOut className="h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
});

// ── Mobile header ───────────────────────────────────────────────────────────

export interface MobileHeaderProps {
  relayStatus: DotState;
  sidebarOpen: boolean;
  providerUsage: ProviderUsageMap | null;
  authSource: string | null;
  usageRefreshing: boolean;
  activeSessionId: string | null;
  agentActive: boolean;
  sessionName: string | null;
  activeModel: ConfiguredModelInfo | null;
  liveSessions: HubSession[];
  sessionSwitcherOpen: boolean;
  userName: string;
  userEmail: string;
  userLabel: string;
  onToggleSidebar: () => void;
  onShowPreferences: () => void;
  onShowApiKeys: () => void;
  onShowRunners: () => void;
  onChangePassword: () => void;
  onRefreshUsage: () => boolean | void;
  onOpenSession: (id: string) => void;
  onNewSession: () => void;
  onSessionSwitcherOpenChange: (open: boolean) => void;
  /** Number of sessions needing user response — shown as badge on sidebar toggle. */
  needsResponseCount?: number;
  onShowHistory?: () => void;
}

export const MobileHeader = React.memo(function MobileHeader({
  relayStatus,
  sidebarOpen,
  providerUsage,
  authSource,
  usageRefreshing,
  activeSessionId,
  agentActive,
  sessionName,
  activeModel,
  liveSessions,
  sessionSwitcherOpen,
  userName,
  userEmail,
  userLabel,
  onToggleSidebar,
  onShowPreferences,
  onShowApiKeys,
  onShowRunners,
  onChangePassword,
  onRefreshUsage,
  onOpenSession,
  onNewSession,
  onSessionSwitcherOpenChange,
  needsResponseCount = 0,
  onShowHistory,
}: MobileHeaderProps) {
  return (
    <header
      className="md:hidden fixed top-0 left-0 right-0 z-50 flex items-center justify-between gap-2 border-b bg-background px-3 pp-safe-left pp-safe-right"
      style={{ paddingTop: "calc(0.5rem + env(safe-area-inset-top))", paddingBottom: "0.5rem" }}
    >
      {/* Left: sidebar toggle with needs-response badge */}
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9 flex-shrink-0 relative"
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? "Close sidebar" : `Open sidebar${needsResponseCount > 0 ? ` — ${needsResponseCount} items need response` : ""}`}
      >
        <PanelLeftOpen className={`h-5 w-5 transition-transform duration-300 ${sidebarOpen ? "rotate-180" : ""}`} />
        {!sidebarOpen && needsResponseCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[14px] h-[14px] rounded-full bg-amber-500 text-white text-[8px] font-bold px-0.5 shadow-[0_0_6px_#f59e0b80]">
            {needsResponseCount > 9 ? "9+" : needsResponseCount}
          </span>
        )}
      </Button>

      {/* Center: session switcher pill or logo */}
      <div className="flex-1 min-w-0 flex justify-center">
        <DropdownMenu open={sessionSwitcherOpen} onOpenChange={onSessionSwitcherOpenChange}>
          <DropdownMenuTrigger asChild>
            {activeSessionId ? (
              <button
                className="inline-flex items-center gap-2 min-w-0 max-w-full rounded-xl bg-muted/50 border border-border/60 px-3 py-1.5 hover:bg-muted transition-colors"
              >
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 transition-colors ${agentActive ? "bg-green-400 shadow-[0_0_5px_#4ade8080] animate-pulse" : "bg-slate-400"}`}
                />
                {activeModel?.provider && (
                  <ProviderIcon provider={activeModel.provider} className="size-3.5 flex-shrink-0" />
                )}
                <span className="truncate text-sm font-medium">
                  {sessionName || `Session ${activeSessionId.slice(0, 8)}…`}
                </span>
                <ChevronsUpDown className="h-3 w-3 opacity-40 flex-shrink-0" />
              </button>
            ) : (
              <button className="inline-flex items-center gap-2 px-2 py-1.5 rounded-xl hover:bg-muted/50 transition-colors">
                <PizzaLogo className="!w-7 !h-7" />
                <span className="text-sm font-semibold">PizzaPi</span>
                <span className={relayStatusDot(relayStatus)} />
              </button>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="w-72 max-h-[70dvh] overflow-y-auto">
            <DropdownMenuLabel className="flex items-center justify-between">
              <span>Sessions</span>
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${relayStatus === "connected" ? "bg-green-500 shadow-[0_0_4px_#22c55e80]" : relayStatus === "connecting" ? "bg-slate-400" : "bg-red-500"}`} />
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {liveSessions.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground text-center italic">No live sessions</div>
            ) : (
              liveSessions
                .slice()
                .sort((a, b) => {
                  const aT = Date.parse(a.lastHeartbeatAt ?? a.startedAt);
                  const bT = Date.parse(b.lastHeartbeatAt ?? b.startedAt);
                  return (Number.isFinite(bT) ? bT : 0) - (Number.isFinite(aT) ? aT : 0);
                })
                .map((s) => {
                  const isActive = s.sessionId === activeSessionId;
                  const provider = s.model?.provider ?? (isActive ? activeModel?.provider : undefined) ?? "unknown";
                  const label = s.sessionName?.trim() || `Session ${s.sessionId.slice(0, 8)}…`;
                  return (
                    <DropdownMenuItem
                      key={s.sessionId}
                      onSelect={() => {
                        onOpenSession(s.sessionId);
                        onSessionSwitcherOpenChange(false);
                      }}
                      className="flex items-center gap-2.5 py-2.5"
                    >
                      {/* Provider icon + activity badge */}
                      <div className="relative flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-md bg-muted">
                        <ProviderIcon provider={provider} className="size-4 text-muted-foreground" />
                        <span
                          className={`absolute -top-0.5 -right-0.5 inline-block h-2 w-2 rounded-full border-2 border-popover ${s.isActive ? "bg-blue-400 animate-pulse" : "bg-green-600"}`}
                          title={s.isActive ? "Generating" : "Idle"}
                        />
                      </div>
                      {/* Name + path */}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{label}</div>
                        {s.cwd && (
                          <div className="text-[0.65rem] text-muted-foreground truncate">{s.cwd.split("/").slice(-2).join("/")}</div>
                        )}
                      </div>
                      {/* Checkmark for active */}
                      {isActive && <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />}
                    </DropdownMenuItem>
                  );
                })
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => { onNewSession(); onSessionSwitcherOpenChange(false); }} className="gap-2">
              <Plus className="h-4 w-4" />
              New session
            </DropdownMenuItem>
            {onShowHistory && (
              <DropdownMenuItem onSelect={() => { onShowHistory(); onSessionSwitcherOpenChange(false); }} className="gap-2">
                <Clock className="h-4 w-4" />
                Session history
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Right: usage + account */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {(providerUsage || authSource) && (
          <div className="hidden xs:flex">
            <UsageIndicator
              usage={providerUsage}
              authSource={authSource}
              activeProvider={activeModel?.provider}
              onRefresh={onRefreshUsage}
              refreshing={usageRefreshing}
            />
          </div>
        )}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="User menu">
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">
                    {initials(userLabel)}
                  </span>
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>User menu</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              <span className="truncate">{userName || "Signed in"}</span>
            </DropdownMenuLabel>
            {userEmail && (
              <div className="px-2 pb-1 text-xs text-muted-foreground truncate">{userEmail}</div>
            )}
            {(providerUsage || authSource) && (
              <div className="px-2 py-1.5 border-t border-border/50">
                <UsageIndicator
                  usage={providerUsage}
                  authSource={authSource}
                  activeProvider={activeModel?.provider}
                  onRefresh={onRefreshUsage}
                  refreshing={usageRefreshing}
                />
              </div>
            )}
            <DropdownMenuSeparator />
            <ThemeMenuItems />
            <DropdownMenuItem onSelect={onShowPreferences}>
              <Settings className="h-4 w-4" />
              Preferences
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onShowApiKeys}>
              <KeyRound className="h-4 w-4" />
              API keys
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onShowRunners}>
              <HardDrive className="h-4 w-4" />
              Runners
            </DropdownMenuItem>
            {onShowHistory && (
              <DropdownMenuItem onSelect={onShowHistory}>
                <Clock className="h-4 w-4" />
                Session history
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={onChangePassword}>
              <Lock className="h-4 w-4" />
              Change password
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => signOut()}>
              <LogOut className="h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
});
