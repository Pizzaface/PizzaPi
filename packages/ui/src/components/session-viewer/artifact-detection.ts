/**
 * Deciding when a tool call produced a deliverable worth showing as an
 * artifact card, rather than as a file-write in a transcript.
 *
 * Pure so the rules are testable without rendering the message tree.
 */

import { isArtifactPath, type ResolvedModeUi } from "@pizzapi/protocol";
import { baseToolName, parseToolInputArgs } from "@/components/session-viewer/utils";

/** How an artifact should be previewed. */
export type ArtifactKind = "markdown" | "image" | "pdf" | "csv" | "html" | "download";

const KIND_BY_EXTENSION: Record<string, ArtifactKind> = {
  md: "markdown",
  markdown: "markdown",
  txt: "markdown",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  pdf: "pdf",
  csv: "csv",
  tsv: "csv",
  html: "html",
  htm: "html",
};

/** File extension (lowercase, no dot), or null when there isn't one. */
export function extensionOf(path: string): string | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Preview kind for a path. Anything without a known preview is "download" —
 * docx/pptx/xlsx are real deliverables that browsers cannot render inline.
 */
export function artifactKindFor(path: string): ArtifactKind {
  const ext = extensionOf(path);
  return (ext && KIND_BY_EXTENSION[ext]) || "download";
}

/** The file path a write-style tool call targeted, if any. */
export function writtenPath(toolName: string | undefined, toolInput: unknown): string | null {
  const base = baseToolName(toolName);
  const isWrite = base === "write" || base === "write_file" || base === "edit";
  if (!isWrite) return null;
  const args = parseToolInputArgs(toolInput);
  const path = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : null;
  return path && path.trim().length > 0 ? path.trim() : null;
}

/**
 * The artifact a tool call produced, or null.
 *
 * Only fires for modes with artifacts enabled, and only for extensions the
 * mode claims — a coding session writing `.ts` is not producing a deliverable.
 */
export function detectArtifact(
  toolName: string | undefined,
  toolInput: unknown,
  modeUi: ResolvedModeUi | null | undefined,
): { path: string; kind: ArtifactKind } | null {
  if (!modeUi?.artifacts) return null;
  const path = writtenPath(toolName, toolInput);
  if (!path || !isArtifactPath(path, modeUi)) return null;
  return { path, kind: artifactKindFor(path) };
}
