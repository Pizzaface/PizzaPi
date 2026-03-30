import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { buildActionResponse, parseActionSigil } from "@/lib/sigils/actions";
import { useActionSigilRuntime } from "./ActionSigilContext";

export interface ActionSigilProps {
  variant: string;
  params: Record<string, string>;
  raw: string;
}

export function ActionSigil({ variant, params, raw }: ActionSigilProps) {
  const runtime = useActionSigilRuntime();
  const parsed = useMemo(() => parseActionSigil(variant, params), [variant, params]);
  const [pending, setPending] = useState(false);
  const [submittedValue, setSubmittedValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");

  if (!parsed.ok) {
    return <RawActionSigil raw={raw} />;
  }

  const action = parsed.action;

  if (!runtime.canInteract && runtime.isMessageComplete) {
    return <RawActionSigil raw={raw} />;
  }

  const disabled = pending || submittedValue !== null || !runtime.canInteract || !runtime.isMessageComplete;

  const submit = async (value: string) => {
    if (disabled || !runtime.sendResponse) return;
    setPending(true);
    setError(null);
    const ok = await runtime.sendResponse(buildActionResponse(action, value)).catch(() => false);
    if (ok) {
      setSubmittedValue(value);
      setPending(false);
      return;
    }
    setPending(false);
    setError("Failed to send response.");
  };

  return (
    <span className="inline-flex max-w-full align-baseline">
      <span
        className={cn(
          "inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-xl border px-2 py-1 text-xs",
          "bg-muted/50 text-foreground border-border",
        )}
        data-sigil={raw}
      >
        <span className="font-medium text-muted-foreground">{action.question}</span>
        {action.kind === "confirm" && (
          <>
            <Button size="sm" type="button" disabled={disabled} onClick={() => void submit("confirm")}>
              Confirm
            </Button>
            <Button size="sm" type="button" variant="outline" disabled={disabled} onClick={() => void submit("cancel")}>
              Cancel
            </Button>
          </>
        )}
        {action.kind === "choose" && action.options.map((option) => (
          <Button
            key={option}
            size="sm"
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => void submit(option)}
          >
            {option}
          </Button>
        ))}
        {action.kind === "input" && (
          <>
            <Input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={action.placeholder}
              disabled={disabled}
              className="h-8 w-40"
              aria-label={action.question}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const value = inputValue.trim();
                  if (!value || disabled) return;
                  void submit(value);
                }
              }}
            />
            <Button
              size="sm"
              type="button"
              disabled={disabled || inputValue.trim().length === 0}
              onClick={() => void submit(inputValue.trim())}
            >
              Submit
            </Button>
          </>
        )}
        {pending && <span className="text-[11px] text-muted-foreground">Sending…</span>}
        {submittedValue !== null && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
            Sent: {submittedValue}
          </span>
        )}
        {!runtime.isMessageComplete && (
          <span className="text-[11px] text-muted-foreground">Waiting for message to finish…</span>
        )}
        {error && <span className="text-[11px] text-destructive">{error}</span>}
      </span>
    </span>
  );
}

function RawActionSigil({ raw }: { raw: string }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-muted-foreground">
      {raw}
    </code>
  );
}
