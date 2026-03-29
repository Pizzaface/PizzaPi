import * as React from "react";
import {
  Edit3,
  Plus,
  Minus,
  HelpCircle,
  FileQuestion,
  File,
  PanelLeft,
  PanelBottom,
  PanelRight,
} from "lucide-react";

// ── Constants ─────────────────────────────────────────────────────────────────

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

export const POSITION_OPTIONS = [
  { pos: "left" as const, Icon: PanelLeft, label: "Left" },
  { pos: "bottom" as const, Icon: PanelBottom, label: "Bottom" },
  { pos: "right" as const, Icon: PanelRight, label: "Right" },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if an Escape keydown should be intercepted by a file-explorer
 * sub-view (file preview, diff preview). We skip interception when:
 *  - The panel is hidden (e.g. inactive CombinedPanel tab — ancestor has `invisible` class)
 *  - A Radix dialog is open anywhere in the app (dialogs own Escape globally)
 *  - A Radix popper/dropdown triggered from within this explorer subtree is open
 *  - Focus is outside the explorer/preview container (e.g. in the composer or
 *    transcript area — including when it has fallen back to document.body)
 */
export function shouldInterceptEscape(el: HTMLElement | null): boolean {
  if (!el) return false; // no ref yet — can't confirm focus, let Escape propagate
  // Hidden in an inactive combined-panel tab?
  if (el.closest(".invisible")) return false;
  // Global Radix dialog open? (dialogs truly own Escape at the document level)
  if (document.querySelector("[role=\"dialog\"][data-state=\"open\"]")) return false;
  // A Radix popper/dropdown triggered from within this explorer subtree is open?
  // Radix portals popper content to <body>, but sets data-state="open" on the
  // trigger element which remains inside our container.
  if (el.querySelector("[data-state=\"open\"]")) return false;
  // Only intercept when focus is strictly inside the explorer/preview container.
  // Do NOT treat document.body as safe — in the docked desktop layout the user
  // may have clicked the transcript/terminal column, which also leaves focus on
  // body, and we must not steal Escape from SessionViewer's abort handler there.
  const active = document.activeElement;
  if (!active || active === document.body || !el.contains(active)) return false;
  return true;
}

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const icons: Record<string, string> = {
    ts: "🟦", tsx: "⚛️", js: "🟨", jsx: "⚛️", json: "📋", md: "📝",
    css: "🎨", html: "🌐", py: "🐍", rs: "🦀", go: "🐹",
    sh: "🐚", bash: "🐚", zsh: "🐚", yml: "⚙️", yaml: "⚙️",
    toml: "⚙️", lock: "🔒", svg: "🖼️", png: "🖼️", jpg: "🖼️",
    gif: "🖼️", webp: "🖼️", mp4: "🎬", mp3: "🎵", pdf: "📄",
    zip: "📦", tar: "📦", gz: "📦", env: "🔐", gitignore: "🚫",
  };
  return icons[ext] ?? "";
}

export function isImageFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

export function getMimeType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
    avif: "image/avif",
  };
  return mimeMap[ext] ?? "image/png";
}

export function gitStatusLabel(status: string): { label: string; color: string; icon: React.ReactNode } {
  switch (status) {
    case "M":
      return { label: "Modified", color: "text-amber-500 dark:text-amber-400", icon: React.createElement(Edit3, { className: "size-3" }) };
    case "A":
      return { label: "Added", color: "text-green-600 dark:text-green-400", icon: React.createElement(Plus, { className: "size-3" }) };
    case "D":
      return { label: "Deleted", color: "text-red-500 dark:text-red-400", icon: React.createElement(Minus, { className: "size-3" }) };
    case "R":
      return { label: "Renamed", color: "text-blue-500 dark:text-blue-400", icon: React.createElement(Edit3, { className: "size-3" }) };
    case "C":
      return { label: "Copied", color: "text-blue-500 dark:text-blue-400", icon: React.createElement(Plus, { className: "size-3" }) };
    case "??":
      return { label: "Untracked", color: "text-muted-foreground", icon: React.createElement(FileQuestion, { className: "size-3" }) };
    case "!!":
      return { label: "Ignored", color: "text-muted-foreground/60", icon: React.createElement(HelpCircle, { className: "size-3" }) };
    case "MM":
      return { label: "Modified (staged+unstaged)", color: "text-amber-500 dark:text-amber-400", icon: React.createElement(Edit3, { className: "size-3" }) };
    case "AM":
      return { label: "Added + Modified", color: "text-green-600 dark:text-green-400", icon: React.createElement(Plus, { className: "size-3" }) };
    default:
      return { label: status, color: "text-muted-foreground", icon: React.createElement(File, { className: "size-3" }) };
  }
}
