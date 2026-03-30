import React from "react";
import { Monitor, Sun, Moon, Check, RotateCcw } from "lucide-react";
import { useTheme, type ThemeMode } from "./ThemeProvider";

// ── Accent color presets (hex) ───────────────────────────────────────────────

const ACCENT_PRESETS = [
  { label: "Blue",   hex: "#3b82f6" },
  { label: "Green",  hex: "#22c55e" },
  { label: "Orange", hex: "#f97316" },
  { label: "Purple", hex: "#a855f7" },
  { label: "Red",    hex: "#ef4444" },
  { label: "Pink",   hex: "#ec4899" },
  { label: "Teal",   hex: "#14b8a6" },
  { label: "Yellow", hex: "#eab308" },
] as const;

const DEFAULT_ACCENT = ""; // empty = no override, use theme default

// ── Color conversion helpers ─────────────────────────────────────────────────

/** Parse hex (#rrggbb) → [r, g, b] in 0–1 range */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** sRGB → linear */
function linearize(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Convert hex to approximate oklch string for CSS variables */
function hexToOklch(hex: string, lightnessOverride?: number): string {
  const [r, g, b] = hexToRgb(hex).map(linearize);
  // sRGB linear → XYZ (D65)
  const x = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  // XYZ → OKLab (approximate via LMS)
  const l_ = Math.cbrt(0.8189 * x + 0.3619 * y - 0.1289 * z);
  const m_ = Math.cbrt(0.0330 * x + 0.9293 * y + 0.0361 * z);
  const s_ = Math.cbrt(0.0482 * x + 0.2641 * y + 0.6338 * z);
  const L = 0.2105 * l_ + 0.7937 * m_ - 0.0041 * s_;
  const a = 1.9780 * l_ - 2.4286 * m_ + 0.4506 * s_;
  const bOk = 0.0259 * l_ + 0.7827 * m_ - 0.8087 * s_;
  const C = Math.sqrt(a * a + bOk * bOk);
  const H = ((Math.atan2(bOk, a) * 180) / Math.PI + 360) % 360;
  const finalL = lightnessOverride ?? L;
  return `oklch(${finalL.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(1)})`;
}

/** Apply a hex accent color as CSS variables on the root element */
function applyAccentColor(hex: string) {
  const el = document.documentElement;
  if (!hex) {
    // Remove overrides — revert to theme defaults
    el.style.removeProperty("--primary");
    el.style.removeProperty("--primary-foreground");
    el.style.removeProperty("--sidebar-primary");
    el.style.removeProperty("--sidebar-primary-foreground");
    el.style.removeProperty("--ring");
    el.removeAttribute("data-accent");
    return;
  }
  const isDark = el.classList.contains("dark");
  // Light mode: darker accent for contrast on white bg. Dark mode: brighter.
  const primary = hexToOklch(hex, isDark ? 0.65 : 0.45);
  const fg = isDark ? "oklch(0.1 0 0)" : "oklch(0.985 0 0)";
  el.style.setProperty("--primary", primary);
  el.style.setProperty("--primary-foreground", fg);
  el.style.setProperty("--sidebar-primary", primary);
  el.style.setProperty("--sidebar-primary-foreground", fg);
  el.style.setProperty("--ring", primary);
  el.setAttribute("data-accent", "custom");
}

// ── Other option constants ───────────────────────────────────────────────────

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
  { value: "'JetBrains Mono', monospace", label: "JetBrains Mono" },
  { value: "'Fira Code', monospace", label: "Fira Code" },
  { value: "'Source Code Pro', monospace", label: "Source Code Pro" },
] as const;

type FontSize = (typeof FONT_SIZE_OPTIONS)[number]["value"];
type Density = (typeof DENSITY_OPTIONS)[number]["value"];
type Radius = (typeof RADIUS_OPTIONS)[number]["value"];
type CodeFont = (typeof CODE_FONT_OPTIONS)[number]["value"];

// ── Reusable segmented control ───────────────────────────────────────────────

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

// ── Main component ───────────────────────────────────────────────────────────

export function AppearanceSettings() {
  const { mode, resolvedTheme, setMode, highContrast, setHighContrast } = useTheme();
  const [accentHex, setAccentHexState] = React.useState<string>(() => {
    return localStorage.getItem("theme-accent-hex") || DEFAULT_ACCENT;
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

  const setAccentHex = React.useCallback((hex: string) => {
    setAccentHexState(hex);
    applyAccentColor(hex);
    if (hex) {
      localStorage.setItem("theme-accent-hex", hex);
    } else {
      localStorage.removeItem("theme-accent-hex");
    }
    // Clean up old preset key if present
    localStorage.removeItem("theme-accent");
  }, []);

  // Re-apply accent when theme mode changes (light/dark affects lightness)
  React.useEffect(() => {
    if (accentHex) applyAccentColor(accentHex);
  }, [resolvedTheme, accentHex]);

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

  // Apply non-accent settings on mount
  React.useEffect(() => {
    if (fontSize !== "default") {
      document.documentElement.setAttribute("data-font-size", fontSize);
    }
    if (density !== "default") {
      document.documentElement.setAttribute("data-density", density);
    }
    document.documentElement.style.setProperty("--radius", radius);
    document.documentElement.style.setProperty("--code-font", codeFont);
  }, [fontSize, density, radius, codeFont]);

  const modeOptions: { value: ThemeMode; icon: typeof Monitor; label: string }[] = [
    { value: "auto", icon: Monitor, label: "Auto" },
    { value: "light", icon: Sun, label: "Light" },
    { value: "dark", icon: Moon, label: "Dark" },
  ];

  return (
    <div className="space-y-6">
      {/* Theme Mode */}
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

      {/* Accent Color — presets + color picker */}
      <div>
        <h3 className="text-sm font-medium mb-1">Accent Color</h3>
        <p className="text-xs text-muted-foreground mb-3">Pick a preset or choose any color</p>
        <div className="flex items-center gap-2 flex-wrap">
          {ACCENT_PRESETS.map(({ label, hex }) => (
            <button
              key={hex}
              onClick={() => setAccentHex(hex)}
              title={label}
              className="relative w-7 h-7 rounded-full border-2 transition-all flex items-center justify-center flex-shrink-0"
              style={{
                backgroundColor: hex,
                borderColor: accentHex === hex ? "var(--foreground)" : "transparent",
              }}
            >
              {accentHex === hex && <Check className="h-3 w-3 text-white drop-shadow-sm" />}
            </button>
          ))}

          {/* Native color picker */}
          <label
            className="relative w-7 h-7 rounded-full border-2 border-dashed border-border cursor-pointer flex items-center justify-center flex-shrink-0 overflow-hidden hover:border-foreground transition-colors"
            title="Custom color"
          >
            <input
              type="color"
              value={accentHex || "#3b82f6"}
              onChange={(e) => setAccentHex(e.target.value)}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            {/* Show the custom color if it's not a preset */}
            {accentHex && !ACCENT_PRESETS.some(p => p.hex === accentHex) ? (
              <span
                className="w-full h-full rounded-full flex items-center justify-center"
                style={{ backgroundColor: accentHex }}
              >
                <Check className="h-3 w-3 text-white drop-shadow-sm" />
              </span>
            ) : (
              <span className="text-[10px] text-muted-foreground font-bold">+</span>
            )}
          </label>

          {/* Reset button */}
          {accentHex && (
            <button
              onClick={() => setAccentHex("")}
              className="h-7 px-2 text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 rounded border border-border hover:bg-muted transition-colors"
              title="Reset to default"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          )}
        </div>
      </div>

      {/* High Contrast */}
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
