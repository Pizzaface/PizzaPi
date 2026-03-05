import * as React from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Radio } from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

/** A channel the session belongs to */
export interface ChannelMembership {
  /** Channel ID/name */
  channelId: string;
  /** Number of members in the channel */
  memberCount: number;
}

export interface ChannelIndicatorProps {
  /** Channels the current session belongs to */
  channels: ChannelMembership[];
  /** Additional CSS class names */
  className?: string;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Small inline indicator showing channel memberships for the current session.
 *
 * Shows each channel name with its member count. Renders nothing when
 * the session is not in any channels.
 */
export const ChannelIndicator = React.memo(function ChannelIndicator({
  channels,
  className,
}: ChannelIndicatorProps) {
  if (channels.length === 0) return null;

  return (
    <div
      className={cn("flex items-center gap-1.5 flex-wrap", className)}
      role="status"
      aria-label={`Member of ${channels.length} channel${channels.length !== 1 ? "s" : ""}`}
    >
      <Radio className="size-3 text-muted-foreground/60 shrink-0" />
      {channels.map((ch) => (
        <Badge
          key={ch.channelId}
          variant="outline"
          className="text-[0.6rem] px-1.5 py-0 h-4 gap-1 font-normal border-violet-500/30 text-violet-400"
          title={`Channel "${ch.channelId}" — ${ch.memberCount} member${ch.memberCount !== 1 ? "s" : ""}`}
        >
          <span className="truncate max-w-20">{ch.channelId}</span>
          <span className="text-muted-foreground/50 tabular-nums">
            {ch.memberCount}
          </span>
        </Badge>
      ))}
    </div>
  );
});
