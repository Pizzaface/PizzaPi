import React from "react";
import { X, Palette, Bell, Layers, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { AppearanceSettings } from "./AppearanceSettings";
import { usePushState } from "./NotificationToggle";
import { useHapticsState } from "./HapticsToggle";

type PreferencesTab = "appearance" | "notifications" | "models";

const TABS: { key: PreferencesTab; label: string; icon: typeof Palette }[] = [
  { key: "appearance", label: "Appearance", icon: Palette },
  { key: "notifications", label: "Notifications", icon: Bell },
  { key: "models", label: "Models", icon: Layers },
];

interface UserPreferencesPanelProps {
  onClose: () => void;
  onShowHiddenModels: () => void;
  hiddenModelCount: number;
}

function NotificationsPreferencesSection() {
  const {
    subscribed,
    loading,
    supported,
    permissionDenied,
    toggle,
    suppressChild,
    suppressChildLoading,
    toggleSuppressChild,
  } = usePushState();
  const { enabled, supported: hapticsSupported, toggle: toggleHaptics } = useHapticsState();

  if (!supported && !hapticsSupported) {
    return (
      <p className="text-sm text-muted-foreground">
        Notifications and haptic feedback are not supported on this device.
      </p>
    );
  }

  const pushStatus = !supported
    ? "Not supported on this device"
    : loading
      ? "Checking notification status…"
      : permissionDenied
        ? "Blocked by your browser settings"
        : subscribed
          ? "Enabled"
          : "Disabled";

  return (
    <div className="space-y-4">
      {supported && (
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">Push notifications</p>
            <p className="text-xs text-muted-foreground">
              Get notified when sessions need attention. Status: {pushStatus}
            </p>
          </div>
          <Switch checked={subscribed} onCheckedChange={toggle} disabled={loading || permissionDenied} />
        </div>
      )}

      {supported && subscribed && (
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">Suppress child session notifications</p>
            <p className="text-xs text-muted-foreground">
              Only notify for the main session, not spawned child sessions.
            </p>
          </div>
          <Switch
            checked={suppressChild}
            onCheckedChange={toggleSuppressChild}
            disabled={suppressChildLoading}
          />
        </div>
      )}

      {hapticsSupported && (
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">Haptic feedback</p>
            <p className="text-xs text-muted-foreground">
              Vibrate on supported devices for quick interaction feedback.
            </p>
          </div>
          <Switch checked={enabled} onCheckedChange={toggleHaptics} />
        </div>
      )}
    </div>
  );
}

function ModelsPreferencesSection({
  hiddenModelCount,
  onShowHiddenModels,
}: {
  hiddenModelCount: number;
  onShowHiddenModels: () => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium">Model visibility</p>
        <p className="text-xs text-muted-foreground">
          Choose which models appear in the model selector.
          {hiddenModelCount > 0 && ` ${hiddenModelCount} model${hiddenModelCount === 1 ? "" : "s"} hidden.`}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onShowHiddenModels}>
        <EyeOff className="h-4 w-4 mr-2" />
        Manage model visibility
      </Button>
    </div>
  );
}

export function UserPreferencesPanel({ onClose, onShowHiddenModels, hiddenModelCount }: UserPreferencesPanelProps) {
  const [activeTab, setActiveTab] = React.useState<PreferencesTab>("appearance");

  return (
    <div className="absolute inset-y-0 right-0 z-40 flex w-full max-w-md flex-col shadow-xl border-l bg-background">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <span className="font-semibold text-sm">Preferences</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex gap-1.5 px-4 py-2 border-b overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md transition-all whitespace-nowrap ${
              activeTab === tab.key
                ? "bg-primary/15 text-primary border border-primary/30"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/40 border border-transparent"
            }`}
          >
            <tab.icon className="h-3.5 w-3.5" />
            {tab.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === "appearance" && <AppearanceSettings />}
        {activeTab === "notifications" && <NotificationsPreferencesSection />}
        {activeTab === "models" && (
          <ModelsPreferencesSection
            hiddenModelCount={hiddenModelCount}
            onShowHiddenModels={onShowHiddenModels}
          />
        )}
      </div>
    </div>
  );
}
