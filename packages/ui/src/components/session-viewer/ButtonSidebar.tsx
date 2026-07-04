import * as React from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ToolbarButtonId } from "@/hooks/useButtonPosition";
import { DraggableToolbarButton } from "@/components/session-viewer/DraggableToolbarButton";
import {
  TerminalIcon,
  FolderTree,
  GitBranch,
  Zap,
  Download,
  Copy,
  OctagonX,
} from "lucide-react";

export interface CommonButtonProps {
  onDragStart?: (buttonId: ToolbarButtonId) => void;
  onToggleTerminal?: () => void;
  onToggleFileExplorer?: () => void;
  onToggleGit?: () => void;
  onToggleTriggers?: () => void;
  onDuplicateSession?: () => void;
  onExport?: () => void;
  onExec?: (payload: unknown) => boolean | void;
  sessionId?: string | null;
  effortLevel?: string | null;
  planModeEnabled?: boolean;
  tokenUsage?: { input: number; output: number; cost: number; cacheRead?: number; cacheWrite?: number } | null;
}

interface ToolbarButtonRenderProps extends CommonButtonProps {
  id: ToolbarButtonId;
  tooltipSide: "top" | "bottom" | "left" | "right";
}

const ICONS: Record<string, React.ReactNode> = {
  terminal: <TerminalIcon className="size-4" />,
  files: <FolderTree className="size-4" />,
  git: <GitBranch className="size-4" />,
  triggers: <Zap className="size-4" />,
  export: <Download className="size-4" />,
  duplicate: <Copy className="size-4" />,
  delete: <OctagonX className="size-4" />,
};

const LABELS: Record<string, string> = {
  effort: "Effort",
  plan: "Plan",
  tokens: "Tokens",
  terminal: "Terminal",
  files: "Files",
  git: "Git",
  triggers: "Triggers",
  export: "Export",
  duplicate: "Duplicate",
  delete: "End",
};

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function ToolbarButton({
  id,
  tooltipSide,
  onDragStart,
  onToggleTerminal,
  onToggleFileExplorer,
  onToggleGit,
  onToggleTriggers,
  onDuplicateSession,
  onExport,
  onExec,
  sessionId,
  effortLevel,
  planModeEnabled,
  tokenUsage,
}: ToolbarButtonRenderProps): React.ReactElement | null {
  if (id === "effort" && effortLevel != null) {
    return (
      <DraggableToolbarButton key={id} buttonId={id} onDragStart={onDragStart}>
        <button
          className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[0.55rem] font-medium text-muted-foreground uppercase tracking-wide hover:bg-muted/80 transition-colors cursor-pointer w-full text-center"
          onClick={() => onExec?.({ type: "exec", id: `${Date.now()}`, command: "cycle_thinking_level" })}
          title="Click to cycle effort level · click-and-hold to reposition"
        >
          {effortLevel !== "off" ? effortLevel : "off"}
        </button>
      </DraggableToolbarButton>
    );
  }

  if (id === "plan" && planModeEnabled) {
    return (
      <DraggableToolbarButton key={id} buttonId={id} onDragStart={onDragStart}>
        <button
          className="rounded-full border border-yellow-500/40 bg-yellow-500/10 px-1.5 py-0.5 text-[0.55rem] font-medium text-yellow-600 dark:text-yellow-400 uppercase tracking-wide hover:bg-yellow-500/20 transition-colors cursor-pointer w-full text-center"
          onClick={() => onExec?.({ type: "exec", id: `${Date.now()}`, command: "set_plan_mode", enabled: false })}
          title="Click to turn off plan mode · click-and-hold to reposition"
        >
          ⏸
        </button>
      </DraggableToolbarButton>
    );
  }

  if (id === "tokens" && tokenUsage && (tokenUsage.input > 0 || tokenUsage.output > 0)) {
    return (
      <DraggableToolbarButton key={id} buttonId={id} onDragStart={onDragStart}>
        <span
          className="text-[0.55rem] text-muted-foreground tabular-nums text-center block"
          title={`↑${tokenUsage.input.toLocaleString()} ↓${tokenUsage.output.toLocaleString()}${tokenUsage.cost > 0 ? ` $${tokenUsage.cost.toFixed(3)}` : ""}\nClick-and-hold to reposition`}
        >
          ↑{formatTokenCount(tokenUsage.input)}
          <br />
          ↓{formatTokenCount(tokenUsage.output)}
        </span>
      </DraggableToolbarButton>
    );
  }

  const icon = ICONS[id];
  if (!icon) return null;

  return (
    <DraggableToolbarButton key={id} buttonId={id} onDragStart={onDragStart}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            className="h-10 w-10 md:h-8 md:w-8"
            size="icon"
            variant="ghost"
            onClick={() => {
              switch (id) {
                case "terminal": onToggleTerminal?.(); break;
                case "files": onToggleFileExplorer?.(); break;
                case "git": onToggleGit?.(); break;
                case "triggers": onToggleTriggers?.(); break;
                case "duplicate": onDuplicateSession?.(); break;
                case "export": onExport?.(); break;
                case "delete":
                  if (onExec && sessionId) {
                    onExec({ type: "exec", id: `${Date.now()}`, command: "end_session" });
                  }
                  break;
              }
            }}
            aria-label={LABELS[id]}
          >
            {icon}
          </Button>
        </TooltipTrigger>
        <TooltipContent side={tooltipSide}>
          {LABELS[id]} · click-and-hold to reposition
        </TooltipContent>
      </Tooltip>
    </DraggableToolbarButton>
  );
}

export function ButtonRail({
  side,
  groups,
  ...rest
}: CommonButtonProps & {
  side: "left" | "right";
  groups: { top: ToolbarButtonId[]; middle: ToolbarButtonId[]; bottom: ToolbarButtonId[] };
}): React.ReactElement | null {
  if (groups.top.length === 0 && groups.middle.length === 0 && groups.bottom.length === 0) {
    return null;
  }

  const tooltipSide = side === "left" ? "right" : "left";

  return (
    <div
      className={cn(
        "flex flex-col h-full shrink-0 gap-1 px-1 py-2",
        "bg-muted/30 border-border",
        side === "left" ? "border-r" : "border-l",
      )}
    >
      <div className="flex flex-col gap-1">
        {groups.top.map((id) => (
          <ToolbarButton key={id} id={id} tooltipSide={tooltipSide} {...rest} />
        ))}
      </div>
      <div className="flex-1 flex flex-col gap-1 items-center justify-center">
        {groups.middle.map((id) => (
          <ToolbarButton key={id} id={id} tooltipSide={tooltipSide} {...rest} />
        ))}
      </div>
      <div className="flex flex-col gap-1">
        {groups.bottom.map((id) => (
          <ToolbarButton key={id} id={id} tooltipSide={tooltipSide} {...rest} />
        ))}
      </div>
    </div>
  );
}

export function ButtonStrip({
  position,
  buttonIds,
  ...rest
}: CommonButtonProps & {
  position: "center-top" | "center-bottom";
  buttonIds: ToolbarButtonId[];
}): React.ReactElement | null {
  if (buttonIds.length === 0) return null;

  const tooltipSide = position === "center-top" ? "bottom" : "top";

  return (
    <div
      className={cn(
        "flex flex-row items-center justify-center gap-1 px-1 py-2",
        "bg-muted/30 border-border",
        position === "center-top" ? "border-b" : "border-t",
      )}
    >
      {buttonIds.map((id) => (
        <ToolbarButton key={id} id={id} tooltipSide={tooltipSide} {...rest} />
      ))}
    </div>
  );
}

