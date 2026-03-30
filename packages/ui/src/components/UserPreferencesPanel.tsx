import React from "react";
import { X, Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { AppearanceSettings } from "./AppearanceSettings";

// Extensible tab system for future preference sections
type PreferencesTab = "appearance";

const TABS: { key: PreferencesTab; label: string; icon: typeof Palette }[] = [
  { key: "appearance", label: "Appearance", icon: Palette },
];

interface UserPreferencesPanelProps {
  onClose: () => void;
}

export function UserPreferencesPanel({ onClose }: UserPreferencesPanelProps) {
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
      {/* Tab bar - only show when there are multiple tabs */}
      {TABS.length > 1 && (
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
      )}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === "appearance" && <AppearanceSettings />}
      </div>
    </div>
  );
}
