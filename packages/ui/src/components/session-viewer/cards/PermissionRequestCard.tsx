import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert } from "lucide-react";

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

interface Props {
  request: ParsedPermissionRequest;
  onDecision: (requestId: string, decision: "allow" | "deny") => void;
}

export function PermissionRequestCard({ request, onDecision }: Props) {
  const inputStr = React.useMemo(() => {
    if (!request.toolInput) return null;
    try { return JSON.stringify(request.toolInput, null, 2); }
    catch { return String(request.toolInput); }
  }, [request.toolInput]);

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 text-amber-500 shrink-0" />
        <span className="font-medium text-sm">Permission Request</span>
        <Badge variant="outline" className="ml-auto text-xs font-mono">{request.toolName}</Badge>
      </div>

      {inputStr && (
        <pre className="text-xs font-mono bg-muted rounded p-2 overflow-x-auto max-h-32 whitespace-pre-wrap break-all">
          {inputStr}
        </pre>
      )}

      <div className="flex gap-2 justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={() => onDecision(request.requestId, "deny")}
          className="text-destructive border-destructive/40 hover:bg-destructive/10"
        >
          Deny
        </Button>
        <Button
          size="sm"
          onClick={() => onDecision(request.requestId, "allow")}
          className="bg-amber-500 hover:bg-amber-600 text-white"
        >
          Allow
        </Button>
      </div>
    </div>
  );
}
