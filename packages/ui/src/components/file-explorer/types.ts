import * as React from "react";

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink?: boolean;
  size?: number;
}

export interface GitChange {
  status: string;
  path: string;
  originalPath?: string;
}

export interface GitStatus {
  branch: string;
  changes: GitChange[];
  ahead: number;
  behind: number;
  diffStaged?: string;
}

export interface FileExplorerProps {
  runnerId: string;
  cwd: string;
  className?: string;
  onClose?: () => void;
  /** Current docked position of the panel (desktop only). */
  position?: "left" | "right" | "bottom";
  /** Called when the user picks a new position via the header buttons. */
  onPositionChange?: (pos: "left" | "right" | "bottom") => void;
  /** Called when the user starts dragging the panel grip to reposition it. */
  onDragStart?: (e: React.PointerEvent) => void;
}

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
