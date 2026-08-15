/**
 * Deciding when a tool call produced a deliverable worth showing as an
 * artifact card, rather than as a file-write in a transcript.
 *
 * Pure so the rules are testable without rendering the message tree.
 */

import { isArtifactPath, type ResolvedModeUi } from "@pizzapi/protocol";
import { baseToolName, parseToolInputArgs } from "@/components/session-viewer/utils";

/**
 * Tool input as an object, including the JSON-string form some providers send.
 * parseToolInputArgs() only handles objects, which would silently drop the
 * artifact for a perfectly good write.
 */
function toolArgs(toolInput: unknown): Record<string, unknown> {
  if (typeof toolInput === "string") {
    try {
      const parsed = JSON.parse(toolInput);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
    return {};
  }
  return parseToolInputArgs(toolInput);
}

/** How an artifact should be previewed. */
export type ArtifactKind = "markdown" | "image" | "pdf" | "csv" | "html" | "download";

const ARTIFACT_KINDS: ReadonlySet<ArtifactKind> = new Set(["markdown", "image", "pdf", "csv", "html", "download"]);

function isArtifactKind(value: string): value is ArtifactKind {
  return ARTIFACT_KINDS.has(value as ArtifactKind);
}

/**
 * Tools whose call IS the model handing a deliverable to the user.
 *
 * An artifact is an intentional act, not a sniffed file write — a mode ships a
 * tool like this so the model can say "here is your document" explicitly.
 */
const PRESENT_ARTIFACT_TOOLS: ReadonlySet<string> = new Set(["present_artifact", "present-artifact", "presentartifact"]);

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
  const args = toolArgs(toolInput);
  const path = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : null;
  return path && path.trim().length > 0 ? path.trim() : null;
}

/** What an artifact card renders. */
export interface DetectedArtifact {
  path: string;
  kind: ArtifactKind;
  /** Human label from an explicit hand-off; falls back to the filename. */
  title?: string;
}

/**
 * The artifact a tool call produced, or null.
 *
 * Two paths. An explicit hand-off (`present_artifact`) is the model choosing to
 * deliver something to the user — honored regardless of extension, because
 * intent beats the allowlist. Otherwise the legacy implicit case: a write to a
 * deliverable path in an artifact-enabled mode (a coding session writing `.ts`
 * is not producing a deliverable).
 */
export function detectArtifact(
  toolName: string | undefined,
  toolInput: unknown,
  modeUi: ResolvedModeUi | null | undefined,
): DetectedArtifact | null {
  if (!modeUi?.artifacts) return null;

  const base = baseToolName(toolName);
  if (base && PRESENT_ARTIFACT_TOOLS.has(base)) {
    const args = toolArgs(toolInput);
    const path = typeof args.path === "string" ? args.path.trim() : "";
    if (!path) return null;
    const kind = typeof args.kind === "string" && isArtifactKind(args.kind) ? args.kind : artifactKindFor(path);
    const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
    return { path, kind, title };
  }

  const path = writtenPath(toolName, toolInput);
  if (!path || !isArtifactPath(path, modeUi)) return null;
  return { path, kind: artifactKindFor(path) };
}
