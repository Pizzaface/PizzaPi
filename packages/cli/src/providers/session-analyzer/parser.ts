import type {
  ParsedEntry,
  ParsedCompactionEntry,
  ParsedMessageEntry,
  Usage,
} from "./types.js";

/**
 * Parse a JSONL string and return typed entries with byte-level consumption tracking.
 *
 * Rules:
 * - Fully-parsed lines (ending in \n) are consumed and their byte length added to
 *   `bytesConsumed`.
 * - Malformed lines that are followed by a newline are skipped once — their bytes
 *   are still consumed so future scans don't stall.
 * - The final line without a trailing newline is treated as an incomplete partial;
 *   it is NOT consumed and `hasTrailingPartial` is set to true.
 * - Empty lines are consumed but produce no entry.
 */
export function parseJsonlEntries(content: string): {
  entries: ParsedEntry[];
  bytesConsumed: number;
  hasTrailingPartial: boolean;
} {
  const entries: ParsedEntry[] = [];
  let bytesConsumed = 0;
  let hasTrailingPartial = false;

  const lines = content.split("\n");
  const endsWithNewline = content.endsWith("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLastLine = i === lines.length - 1;

    if (isLastLine && !endsWithNewline) {
      if (line.length > 0) {
        hasTrailingPartial = true;
      }
      break;
    }

    // Last element after a trailing newline is an empty string — nothing to do.
    if (isLastLine && endsWithNewline && line.length === 0) {
      break;
    }

    // Advance past this line + its terminating newline.
    const lineBytes = Buffer.byteLength(line, "utf-8");
    bytesConsumed += lineBytes + 1; // +1 for the \n delimiter

    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    try {
      const obj = JSON.parse(trimmed);
      entries.push(obj as ParsedEntry);
    } catch {
      // Malformed line — skip it, but bytes are already consumed.
    }
  }

  return { entries, bytesConsumed, hasTrailingPartial };
}

/** Extract usage data from an assistant message entry, or undefined if not present. */
export function extractAssistantUsage(entry: ParsedEntry): Usage | undefined {
  if (entry.type !== "message") return undefined;
  const msg = (entry as ParsedMessageEntry).message;
  if (msg.role !== "assistant") return undefined;
  return msg.usage;
}

/** Return all compaction entries found in the parsed list. */
export function detectCompactions(entries: ParsedEntry[]): ParsedCompactionEntry[] {
  return entries.filter((e): e is ParsedCompactionEntry => e.type === "compaction");
}
