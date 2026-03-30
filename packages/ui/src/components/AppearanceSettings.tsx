import React from "react";
import { Monitor, Sun, Moon, Check } from "lucide-react";
import { useTheme, type ThemeMode } from "./ThemeProvider";

const ACCENT_OPTIONS = [
  { value: "default", label: "Default", color: "oklch(0.488 0.243 264.376)" },
  { value: "green", label: "Green", color: "oklch(0.55 0.2 155)" },
  { value: "orange", label: "Orange", color: "oklch(0.6 0.2 50)" },
  { value: "purple", label: "Purple", color: "oklch(0.55 0.25 300)" },
] as const;

const FONT_SIZE_OPTIONS = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
] as const;

const DENSITY_OPTIONS = [
  { value: "compact", label: "Compact" },
  { value: "default", label: "Default" },
  { value: "comfortable", label: "Comfortable" },
] as const;

const RADIUS_OPTIONS = [
  { value: "0", label: "None" },
  { value: "0.375rem", label: "Small" },
  { value: "0.625rem", label: "Default" },
  { value: "1rem", label: "Large" },
] as const;

const CODE_FONT_OPTIONS = [
  { value: "ui-monospace, monospace", label: "System" },
  { value: "'JetBrains Mono', monospace", label: "JetBrains Mono (requires local install)" },
  { value: "'Fira Code', monospace", label: "Fira Code (requires local install)" },
  { value: "'Source Code Pro', monospace", label: "Source Code Pro (requires local install)" },
] as const;

export type AccentColor = (typeof ACCENT_OPTIONS)[number]["value"];
type FontSize = (typeof FONT_SIZE_OPTIONS)[number]["value"];
type Density = (typeof DENSITY_OPTIONS)[number]["value"];
type Radius = (typeof RADIUS_OPTIONS)[number]["value"];
type CodeFont = (typeof CODE_FONT_OPTIONS)[number]["value"];

function OptionGroup<T extends string>({
  label,
  description,
  options,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <h3 className="text-sm font-medium mb-1">{label}</h3>
      {description && <p className="text-xs text-muted-foreground mb-3">{description}</p>}
      <div className="flex gap-1 p-1 bg-muted rounded-lg">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              value === opt.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function AppearanceSettings() {
  const { mode, setMode, highContrast, setHighContrast } = useTheme();
  const [accent, setAccentState] = React.useState<AccentColor>(() => {
    return (localStorage.getItem("theme-accent") as AccentColor) || "default";
  });
  const [fontSize, setFontSizeState] = React.useState<FontSize>(() => {
    return (localStorage.getItem("theme-font-size") as FontSize) || "default";
  });
  const [density, setDensityState] = React.useState<Density>(() => {
    return (localStorage.getItem("theme-density") as Density) || "default";
  });
  const [radius, setRadiusState] = React.useState<Radius>(() => {
    return (localStorage.getItem("theme-radius") as Radius) || "0.625rem";
  });
  const [codeFont, setCodeFontState] = React.useState<CodeFont>(() => {
    return (localStorage.getItem("theme-code-font") as CodeFont) || "ui-monospace, monospace";
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

  const setFontSize = React.useCallback((next: FontSize) => {
    setFontSizeState(next);
    if (next === "default") {
      document.documentElement.removeAttribute("data-font-size");
      localStorage.removeItem("theme-font-size");
    } else {
      document.documentElement.setAttribute("data-font-size", next);
      localStorage.setItem("theme-font-size", next);
    }
  }, []);

  const setDensity = React.useCallback((next: Density) => {
    setDensityState(next);
    if (next === "default") {
      document.documentElement.removeAttribute("data-density");
      localStorage.removeItem("theme-density");
    } else {
      document.documentElement.setAttribute("data-density", next);
      localStorage.setItem("theme-density", next);
    }
  }, []);

  const setRadius = React.useCallback((next: Radius) => {
    setRadiusState(next);
    document.documentElement.style.setProperty("--radius", next);
    if (next === "0.625rem") {
      localStorage.removeItem("theme-radius");
    } else {
      localStorage.setItem("theme-radius", next);
    }
  }, []);

  const setCodeFont = React.useCallback((next: CodeFont) => {
    setCodeFontState(next);
    document.documentElement.style.setProperty("--code-font", next);
    if (next === "ui-monospace, monospace") {
      localStorage.removeItem("theme-code-font");
    } else {
      localStorage.setItem("theme-code-font", next);
    }
  }, []);

  React.useEffect(() => {
    if (accent !== "default") {
      document.documentElement.setAttribute("data-accent", accent);
    }
    if (fontSize !== "default") {
      document.documentElement.setAttribute("data-font-size", fontSize);
    }
    if (density !== "default") {
      document.documentElement.setAttribute("data-density", density);
    }
    document.documentElement.style.setProperty("--radius", radius);
    document.documentElement.style.setProperty("--code-font", codeFont);
  }, [accent, fontSize, density, radius, codeFont]);

  const modeOptions: { value: ThemeMode; icon: typeof Monitor; label: string }[] = [
    { value: "auto", icon: Monitor, label: "Auto" },
    { value: "light", icon: Sun, label: "Light" },
    { value: "dark", icon: Moon, label: "Dark" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium mb-3">Theme Mode</h3>
        <div className="flex gap-1 p-1 bg-muted rounded-lg">
          {modeOptions.map(({ value, icon: Icon, label }) => (
            <button
              key={value}
              onClick={() => setMode(value)}
              className={`flex-1 inline-flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                mode === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
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

      <div className="border-t pt-6">
        <OptionGroup
          label="Font Size"
          description="Adjust chat message text size."
          options={FONT_SIZE_OPTIONS}
          value={fontSize}
          onChange={setFontSize}
        />
      </div>

      <div className="border-t pt-6">
        <OptionGroup
          label="UI Density"
          description="Control spacing and padding throughout the interface."
          options={DENSITY_OPTIONS}
          value={density}
          onChange={setDensity}
        />
      </div>

      <div className="border-t pt-6">
        <OptionGroup
          label="Border Radius"
          description="Choose how rounded interface elements should appear."
          options={RADIUS_OPTIONS}
          value={radius}
          onChange={setRadius}
        />
      </div>

      <div className="border-t pt-6">
        <OptionGroup
          label="Code Font"
          description="Set the monospace font used for code blocks and terminal output."
          options={CODE_FONT_OPTIONS}
          value={codeFont}
          onChange={setCodeFont}
        />
      </div>
    </div>
  );
}
