import * as React from "react";

export type ThemeMode = "auto" | "light" | "dark";

interface ThemeContextValue {
  mode: ThemeMode;
  resolvedTheme: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function getSystemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(mode: ThemeMode): "light" | "dark" {
  if (mode === "auto") return getSystemDark() ? "dark" : "light";
  return mode;
}

function migrateOldTheme(): ThemeMode {
  const oldVal = localStorage.getItem("theme");
  if (oldVal === "dark" || oldVal === "light") {
    localStorage.setItem("theme-mode", oldVal);
    localStorage.removeItem("theme");
    return oldVal;
  }
  return (localStorage.getItem("theme-mode") as ThemeMode) || "auto";
}

function applyTheme(resolved: "light" | "dark") {
  document.documentElement.classList.toggle("dark", resolved === "dark");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "dark" ? "#1c1917" : "#ffffff");
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = React.useState<ThemeMode>(migrateOldTheme);
  const [resolvedTheme, setResolvedTheme] = React.useState<"light" | "dark">(() => resolve(mode));

  const setMode = React.useCallback((m: ThemeMode) => {
    localStorage.setItem("theme-mode", m);
    setModeState(m);
    const r = resolve(m);
    setResolvedTheme(r);
    applyTheme(r);
  }, []);

  // Apply on mount and listen for system changes when auto
  React.useEffect(() => {
    applyTheme(resolve(mode));
  }, [mode]);

  React.useEffect(() => {
    if (mode !== "auto") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const r = resolve("auto");
      setResolvedTheme(r);
      applyTheme(r);
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [mode]);

  const value = React.useMemo(() => ({ mode, resolvedTheme, setMode }), [mode, resolvedTheme, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
