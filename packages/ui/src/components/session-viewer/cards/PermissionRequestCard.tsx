import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, FileTextIcon, ChevronDownIcon } from "lucide-react";
import type { ParsedPermissionRequest } from "./permission-request";

interface Props {
  request: ParsedPermissionRequest;
  onDecision: (requestId: string, decision: "allow" | "deny") => void;
}

export function PermissionRequestCard({ request, onDecision }: Props) {
  const isExitPlanMode = request.toolName === "ExitPlanMode";
  const planContent = React.useMemo(() => {
    if (!isExitPlanMode || !request.toolInput) return null;
    const input = request.toolInput as Record<string, unknown>;
    return typeof input.plan === "string" ? input.plan : null;
  }, [isExitPlanMode, request.toolInput]);

  const planFilePath = React.useMemo(() => {
    if (!isExitPlanMode || !request.toolInput) return null;
    const input = request.toolInput as Record<string, unknown>;
    return typeof input.planFilePath === "string" ? input.planFilePath : null;
  }, [isExitPlanMode, request.toolInput]);

  const inputStr = React.useMemo(() => {
    if (!request.toolInput) return null;
    // For ExitPlanMode, don't show raw JSON — the plan content is rendered separately
    if (isExitPlanMode && planContent) return null;
    try { return JSON.stringify(request.toolInput, null, 2); }
    catch { return String(request.toolInput); }
  }, [request.toolInput, isExitPlanMode, planContent]);

  // ExitPlanMode → plan review card
  if (isExitPlanMode && planContent) {
    const planTitle = planContent.match(/^#\s+(?:Plan:\s*)?(.+)/m)?.[1] ?? "Plan";
    const planFileName = planFilePath?.split(/[\\/]/).pop() ?? "plan.md";

    return (
      <div className="rounded-lg border border-blue-500/40 bg-blue-500/5 p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <FileTextIcon className="size-4 text-blue-400 shrink-0" />
          <span className="font-medium text-sm">Plan Review</span>
          <Badge variant="outline" className="ml-auto text-xs font-mono">{planFileName}</Badge>
        </div>

        <div className="text-sm font-medium text-zinc-200">{planTitle}</div>

        <details className="group">
          <summary className="cursor-pointer list-none">
            <div className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-400 transition-colors">
              <span>View plan details</span>
              <ChevronDownIcon className="size-3 transition-transform group-open:rotate-180" />
            </div>
          </summary>
          <pre className="mt-2 text-xs font-mono bg-muted rounded p-3 overflow-auto max-h-64 whitespace-pre-wrap break-words">
            {planContent}
          </pre>
        </details>

        <div className="flex gap-2 justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onDecision(request.requestId, "deny")}
            className="text-destructive border-destructive/40 hover:bg-destructive/10"
          >
            Reject
          </Button>
          <Button
            size="sm"
            onClick={() => onDecision(request.requestId, "allow")}
            className="bg-blue-500 hover:bg-blue-600 text-white"
          >
            Approve Plan
          </Button>
        </div>
      </div>
    );
  }

  // Default permission request card
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
