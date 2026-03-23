export interface ParsedPermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: unknown;
  ts: number;
}

/** Parse a raw relay event into a permission request, or null if not applicable. */
export function parsePermissionRequest(event: unknown): ParsedPermissionRequest | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "permission_request") return null;
  if (typeof e.requestId !== "string" || !e.requestId) return null;
  return {
    requestId: e.requestId,
    toolName: typeof e.toolName === "string" ? e.toolName : "Unknown Tool",
    toolInput: e.toolInput ?? null,
    ts: typeof e.ts === "number" ? e.ts : Date.now(),
  };
}
