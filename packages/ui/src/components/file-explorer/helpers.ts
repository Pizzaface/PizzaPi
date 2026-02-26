import * as React from "react";
import {
  Edit3,
  Plus,
  Minus,
  HelpCircle,
  FileQuestion,
  File,
} from "lucide-react";
import { IMAGE_EXTENSIONS } from "./types";

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
      return { label: "Modified", color: "text-amber-400", icon: React.createElement(Edit3, { className: "size-3" }) };
    case "A":
      return { label: "Added", color: "text-green-400", icon: React.createElement(Plus, { className: "size-3" }) };
    case "D":
      return { label: "Deleted", color: "text-red-400", icon: React.createElement(Minus, { className: "size-3" }) };
    case "R":
      return { label: "Renamed", color: "text-blue-400", icon: React.createElement(Edit3, { className: "size-3" }) };
    case "C":
      return { label: "Copied", color: "text-blue-400", icon: React.createElement(Plus, { className: "size-3" }) };
    case "??":
      return { label: "Untracked", color: "text-zinc-400", icon: React.createElement(FileQuestion, { className: "size-3" }) };
    case "!!":
      return { label: "Ignored", color: "text-zinc-600", icon: React.createElement(HelpCircle, { className: "size-3" }) };
    case "MM":
      return { label: "Modified (staged+unstaged)", color: "text-amber-400", icon: React.createElement(Edit3, { className: "size-3" }) };
    case "AM":
      return { label: "Added + Modified", color: "text-green-400", icon: React.createElement(Plus, { className: "size-3" }) };
    default:
      return { label: status, color: "text-zinc-400", icon: React.createElement(File, { className: "size-3" }) };
  }
}
