import * as React from "react";
import type { TriggerType, TriggerConfig, TriggerDelivery } from "@pizzapi/protocol";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// ── Type metadata ────────────────────────────────────────────────────────────

const TRIGGER_TYPES: { value: TriggerType; label: string; icon: string; description: string }[] = [
  { value: "timer", label: "Timer", icon: "⏱️", description: "Fire after a delay, optionally recurring" },
  { value: "session_ended", label: "Session Ended", icon: "🏁", description: "Fire when target sessions end" },
  { value: "session_idle", label: "Session Idle", icon: "💤", description: "Fire when sessions go idle" },
  { value: "session_error", label: "Session Error", icon: "❌", description: "Fire on session errors" },
  { value: "cost_exceeded", label: "Cost Exceeded", icon: "💰", description: "Fire when cost exceeds threshold" },
  { value: "custom_event", label: "Custom Event", icon: "📢", description: "Fire when a named event is emitted" },
];

// ── Props ────────────────────────────────────────────────────────────────────

export interface CreateTriggerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: {
    type: TriggerType;
    config: TriggerConfig;
    delivery?: TriggerDelivery;
    message?: string;
    maxFirings?: number;
  }) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export function CreateTriggerDialog({ open, onOpenChange, onSubmit }: CreateTriggerDialogProps) {
  const [type, setType] = React.useState<TriggerType>("timer");
  const [deliveryMode, setDeliveryMode] = React.useState<"inject" | "queue">("inject");
  const [message, setMessage] = React.useState("");

  // Timer-specific
  const [delaySec, setDelaySec] = React.useState("300");
  const [recurring, setRecurring] = React.useState(false);

  // Session-specific (session_ended, session_idle, session_error)
  const [sessionIds, setSessionIds] = React.useState("*");

  // Cost-specific
  const [costThreshold, setCostThreshold] = React.useState("1.00");

  // Custom event
  const [eventName, setEventName] = React.useState("");
  const [fromSessionIds, setFromSessionIds] = React.useState("*");

  // Max firings (optional)
  const [maxFirings, setMaxFirings] = React.useState("");

  const resetForm = React.useCallback(() => {
    setType("timer");
    setDeliveryMode("inject");
    setMessage("");
    setDelaySec("300");
    setRecurring(false);
    setSessionIds("*");
    setCostThreshold("1.00");
    setEventName("");
    setFromSessionIds("*");
    setMaxFirings("");
  }, []);

  const handleSubmit = React.useCallback(() => {
    let config: TriggerConfig;

    switch (type) {
      case "timer":
        config = {
          delaySec: Math.max(1, parseInt(delaySec, 10) || 60),
          ...(recurring ? { recurring: true } : {}),
        };
        break;
      case "session_ended":
      case "session_idle":
      case "session_error":
        config = {
          sessionIds: sessionIds.trim() === "*" ? "*" : sessionIds.split(",").map((s) => s.trim()).filter(Boolean),
        };
        break;
      case "cost_exceeded":
        config = {
          sessionIds: sessionIds.trim() === "*" ? "*" : sessionIds.split(",").map((s) => s.trim()).filter(Boolean),
          threshold: Math.max(0.01, parseFloat(costThreshold) || 1.0),
        };
        break;
      case "custom_event":
        config = {
          eventName: eventName.trim() || "unnamed_event",
          fromSessionIds: fromSessionIds.trim() === "*" ? "*" : fromSessionIds.split(",").map((s) => s.trim()).filter(Boolean),
        };
        break;
    }

    const maxFiringsNum = maxFirings.trim() ? parseInt(maxFirings, 10) : undefined;

    onSubmit({
      type,
      config,
      delivery: { mode: deliveryMode },
      message: message.trim() || undefined,
      maxFirings: maxFiringsNum && maxFiringsNum > 0 ? maxFiringsNum : undefined,
    });

    resetForm();
    onOpenChange(false);
  }, [type, delaySec, recurring, sessionIds, costThreshold, eventName, fromSessionIds, deliveryMode, message, maxFirings, onSubmit, onOpenChange, resetForm]);

  const selectedMeta = TRIGGER_TYPES.find((t) => t.value === type)!;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetForm(); onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>Create Trigger</span>
          </DialogTitle>
          <DialogDescription>
            Set up an automated trigger for this session.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Trigger type */}
          <div className="space-y-1.5">
            <Label className="text-xs">Trigger Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as TriggerType)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRIGGER_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value} className="text-xs">
                    <span className="mr-1.5">{t.icon}</span>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[0.65rem] text-muted-foreground">{selectedMeta.description}</p>
          </div>

          {/* Type-specific config */}
          {type === "timer" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="delay" className="text-xs">Delay (seconds)</Label>
                <Input
                  id="delay"
                  type="number"
                  min="1"
                  value={delaySec}
                  onChange={(e) => setDelaySec(e.target.value)}
                  className="h-8 text-xs"
                  placeholder="300"
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={recurring}
                  onChange={(e) => setRecurring(e.target.checked)}
                  className="rounded border-border"
                />
                <span className="text-xs text-foreground/80">Recurring (repeat every interval)</span>
              </label>
            </div>
          )}

          {(type === "session_ended" || type === "session_idle" || type === "session_error") && (
            <div className="space-y-1.5">
              <Label htmlFor="sessionIds" className="text-xs">Session IDs</Label>
              <Input
                id="sessionIds"
                value={sessionIds}
                onChange={(e) => setSessionIds(e.target.value)}
                className="h-8 text-xs"
                placeholder='* for all, or comma-separated IDs'
              />
              <p className="text-[0.65rem] text-muted-foreground">Use * to watch all sessions on this runner</p>
            </div>
          )}

          {type === "cost_exceeded" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="sessionIdsCost" className="text-xs">Session IDs</Label>
                <Input
                  id="sessionIdsCost"
                  value={sessionIds}
                  onChange={(e) => setSessionIds(e.target.value)}
                  className="h-8 text-xs"
                  placeholder='* for all, or comma-separated IDs'
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="threshold" className="text-xs">Cost Threshold ($)</Label>
                <Input
                  id="threshold"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={costThreshold}
                  onChange={(e) => setCostThreshold(e.target.value)}
                  className="h-8 text-xs"
                  placeholder="1.00"
                />
              </div>
            </div>
          )}

          {type === "custom_event" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="eventName" className="text-xs">Event Name</Label>
                <Input
                  id="eventName"
                  value={eventName}
                  onChange={(e) => setEventName(e.target.value)}
                  className="h-8 text-xs"
                  placeholder="my_custom_event"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fromIds" className="text-xs">From Session IDs</Label>
                <Input
                  id="fromIds"
                  value={fromSessionIds}
                  onChange={(e) => setFromSessionIds(e.target.value)}
                  className="h-8 text-xs"
                  placeholder='* for all, or comma-separated IDs'
                />
              </div>
            </div>
          )}

          {/* Message template */}
          <div className="space-y-1.5">
            <Label htmlFor="message" className="text-xs">Message (delivered when trigger fires)</Label>
            <Input
              id="message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="h-8 text-xs"
              placeholder="e.g. Time to check on progress!"
            />
          </div>

          {/* Delivery mode */}
          <div className="space-y-1.5">
            <Label className="text-xs">Delivery Mode</Label>
            <Select value={deliveryMode} onValueChange={(v) => setDeliveryMode(v as "inject" | "queue")}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inject" className="text-xs">
                  Inject — directly into running conversation
                </SelectItem>
                <SelectItem value="queue" className="text-xs">
                  Queue — enqueue for next check_messages
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Max firings */}
          <div className="space-y-1.5">
            <Label htmlFor="maxFirings" className="text-xs">Max Firings (optional)</Label>
            <Input
              id="maxFirings"
              type="number"
              min="1"
              value={maxFirings}
              onChange={(e) => setMaxFirings(e.target.value)}
              className="h-8 text-xs"
              placeholder="Leave empty for unlimited"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { resetForm(); onOpenChange(false); }}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit}>
            Create Trigger
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
