import React from "react";
import { Monitor, Sun, Moon, Check } from "lucide-react";
import { useTheme, type ThemeMode } from "./ThemeProvider";

const ACCENT_OPTIONS = [
  { value: "default", label: "Default", color: "oklch(0.488 0.243 264.376)" },
  { value: "green", label: "Green", color: "oklch(0.55 0.2 155)" },
  { value: "orange", label: "Orange", color: "oklch(0.6 0.2 50)" },
  { value: "purple", label: "Purple", color: "oklch(0.55 0.25 300)" },
] as const;

export type AccentColor = (typeof ACCENT_OPTIONS)[number]["value"];

export function AppearanceSettings() {
  const { mode, setMode, highContrast, setHighContrast } = useTheme();
  const [accent, setAccentState] = React.useState<AccentColor>(() => {
    return (localStorage.getItem("theme-accent") as AccentColor) || "default";
  });

  const setAccent = React.useCallback((a: AccentColor) => {
    setAccentState(a);
    if (a === "default") {
      document.documentElement.removeAttribute("data-accent");
      localStorage.removeItem("theme-accent");
    } else {
      document.documentElement.setAttribute("data-accent", a);
      localStorage.setItem("theme-accent", a);
    }
  }, []);

  // Apply accent on mount
  React.useEffect(() => {
    if (accent !== "default") {
      document.documentElement.setAttribute("data-accent", accent);
    }
  }, []);

  const modeOptions: { value: ThemeMode; icon: typeof Monitor; label: string }[] = [
    { value: "auto", icon: Monitor, label: "Auto" },
    { value: "light", icon: Sun, label: "Light" },
    { value: "dark", icon: Moon, label: "Dark" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium mb-3">Theme Mode</h3>
        <div className="flex gap-2">
          {modeOptions.map(({ value, icon: Icon, label }) => (
            <button
              key={value}
              onClick={() => setMode(value)}
              className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm border transition-colors ${
                mode === value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border hover:bg-accent"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium mb-3">Accent Color</h3>
        <div className="flex gap-3">
          {ACCENT_OPTIONS.map(({ value, label, color }) => (
            <button
              key={value}
              onClick={() => setAccent(value)}
              title={label}
              className="relative w-8 h-8 rounded-full border-2 transition-all flex items-center justify-center"
              style={{
                backgroundColor: color,
                borderColor: accent === value ? "var(--foreground)" : "transparent",
              }}
            >
              {accent === value && <Check className="h-4 w-4 text-white" />}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={highContrast}
            onChange={(e) => setHighContrast(e.target.checked)}
            className="rounded border-border"
          />
          <div>
            <span className="text-sm font-medium">High contrast</span>
            <p className="text-xs text-muted-foreground">Increases contrast for better readability</p>
          </div>
        </label>
      </div>
    </div>
  );
}
