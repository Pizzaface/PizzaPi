import * as React from "react";
import { Vibrate, VibrateOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  supportsHaptics,
  isHapticsEnabled,
  setHapticsEnabled,
} from "@/lib/haptics";

function useHapticsState() {
  const [enabled, setEnabled] = React.useState(isHapticsEnabled);
  const supported = React.useMemo(() => supportsHaptics(), []);

  const toggle = React.useCallback(() => {
    const next = !enabled;
    setHapticsEnabled(next);
    setEnabled(next);
    // Give a quick test buzz when enabling
    if (next && typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(15);
    }
  }, [enabled]);

  return { enabled, supported, toggle };
}

export function HapticsToggle() {
  const { enabled, supported, toggle } = useHapticsState();

  if (!supported) return null;

  const label = enabled
    ? "Haptic feedback enabled (click to disable)"
    : "Enable haptic feedback";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            className="h-9 w-9"
            aria-label={label}
          >
            {enabled ? (
              <Vibrate className="h-4 w-4 text-foreground" />
            ) : (
              <VibrateOff className="h-4 w-4 text-muted-foreground opacity-50" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Haptics toggle rendered as a DropdownMenuItem (for mobile menus).
 */
export function MobileHapticsMenuItem() {
  const { enabled, supported, toggle } = useHapticsState();

  if (!supported) return null;

  return (
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault();
        toggle();
      }}
    >
      {enabled ? (
        <Vibrate className="h-4 w-4" />
      ) : (
        <VibrateOff className="h-4 w-4" />
      )}
      {enabled ? "Disable haptic feedback" : "Enable haptic feedback"}
    </DropdownMenuItem>
  );
}
