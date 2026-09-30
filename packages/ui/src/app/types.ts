import type * as React from "react";

/** A message submitted from the composer (plain text or text + attachments). */
export type SessionInputMessage =
  | {
      text: string;
      files?: Array<{ file?: File; mediaType?: string; filename?: string; url?: string }>;
      deliverAs?: "steer" | "followUp";
      suppressOptimistic?: boolean;
    }
  | string;

/** Toast shown for ctx.ui.notify() events and frontend-log toasts. */
export interface Toast {
  id: string;
  message: string;
  type: "info" | "warning" | "error";
}

/** Single-artifact side viewer target. */
export type ArtifactViewerTarget = {
  path: string;
  kind: import("@/components/session-viewer/artifact-detection").ArtifactKind;
  title?: string;
} | null;

/** Sidebar runner row (persisted per user in sessionStorage). */
export interface SidebarRunner {
  runnerId: string;
  name: string | null;
  sessionCount: number;
  version: string | null;
  isOnline: boolean;
}

export type StateSetter<T> = React.Dispatch<React.SetStateAction<T>>;
