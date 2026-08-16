import * as React from "react";
import { CheckIcon, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { MessageResponse } from "@/components/ai-elements/message";
import { DynamicLucideIcon } from "@/components/service-panels/lucide-icon";
import type { MetaPendingApproval, ApprovalDecision } from "@pizzapi/protocol";

/**
 * An extension's request for the user to approve a gated action before it runs.
 *
 * Enforcement lives in the worker (pi `tool_call` block); this card is the
 * decision surface. Editable fields let the user tweak the action (e.g. an
 * email body) before approving — edits ride back in the decision.
 */
export function ApprovalCard({
  approval,
  onDecision,
}: {
  approval: MetaPendingApproval;
  /** Send the decision back to the worker. Return false if delivery failed. */
  onDecision: (decision: ApprovalDecision) => boolean | void | Promise<boolean | void>;
}) {
  const editableKeys = React.useMemo(
    () => (approval.fields ?? []).filter((f) => f.editable).map((f) => f.key),
    [approval.fields],
  );

  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries((approval.fields ?? []).map((f) => [f.key, f.value])),
  );
  const [submitting, setSubmitting] = React.useState<string | null>(null);

  // Reset editable state when a new prompt takes over the same card slot.
  React.useEffect(() => {
    setValues(Object.fromEntries((approval.fields ?? []).map((f) => [f.key, f.value])));
    setSubmitting(null);
  }, [approval.promptId, approval.fields]);

  const edits = React.useMemo(() => {
    const out: Record<string, string> = {};
    for (const key of editableKeys) {
      const original = approval.fields?.find((f) => f.key === key)?.value ?? "";
      if (values[key] !== original) out[key] = values[key] ?? "";
    }
    return out;
  }, [editableKeys, values, approval.fields]);

  const decide = async (action: string, approved: boolean) => {
    if (submitting) return;
    setSubmitting(action);
    const decision: ApprovalDecision = {
      action,
      approved,
      ...(approved && Object.keys(edits).length > 0 ? { edits } : {}),
    };
    const result = await onDecision(decision);
    if (result === false) setSubmitting(null);
  };

  const actions =
    approval.actions && approval.actions.length > 0
      ? approval.actions
      : [
          { id: "approve", label: "Approve", style: "primary" as const },
          { id: "reject", label: "Reject", style: "danger" as const },
        ];

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-amber-500/40 bg-amber-500/[0.04] shadow-sm">
      <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2">
        <DynamicLucideIcon
          name={approval.icon ?? "shield-alert"}
          className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <span className="truncate text-sm font-medium">{approval.title}</span>
        {approval.toolName && (
          <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground">
            {approval.toolName}
          </span>
        )}
      </div>

      <div className="space-y-3 px-3 py-3">
        {approval.message && (
          <div className="text-sm">
            <MessageResponse>{approval.message}</MessageResponse>
          </div>
        )}

        {(approval.fields ?? []).map((field) => (
          <div key={field.key} className="space-y-1">
            <Label className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">{field.label}</Label>
            {field.editable ? (
              field.multiline ? (
                <Textarea
                  value={values[field.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                  className="min-h-[6rem] text-sm"
                  disabled={!!submitting}
                />
              ) : (
                <Input
                  value={values[field.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                  className="text-sm"
                  disabled={!!submitting}
                />
              )
            ) : (
              <div className="whitespace-pre-wrap break-words rounded-md bg-muted/50 px-2 py-1.5 text-sm">
                {field.value || <span className="text-muted-foreground">—</span>}
              </div>
            )}
          </div>
        ))}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          {actions.map((action) => {
            const approved = action.id === "approve";
            const danger = action.style === "danger" || action.id === "reject";
            return (
              <Button
                key={action.id}
                size="sm"
                variant={action.style === "primary" || approved ? "default" : danger ? "destructive" : "outline"}
                disabled={!!submitting}
                onClick={() => void decide(action.id, approved)}
                className={cn(approved && "gap-1")}
              >
                {approved ? <CheckIcon className="size-3.5" /> : danger ? <XIcon className="size-3.5" /> : null}
                {action.label}
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
