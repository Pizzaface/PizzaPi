import * as React from "react";
import { Button } from "@/components/ui/button";
import { Copy, Check } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Banner shown once when a secret (API key / token) is first created.
 *
 * Displays the secret value with copy + dismiss buttons.
 * Replaces the identical banners in ApiKeyManager and RunnerTokenManager.
 */
export function RevealedSecretBanner({
  value,
  onDismiss,
  label,
}: {
  value: string;
  onDismiss: () => void;
  /** Optional caption identifying what the secret is (e.g. "HMAC secret"). */
  label?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-1 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2">
      {label && (
        <span className="text-[11px] font-medium text-green-700 dark:text-green-400">{label}</span>
      )}
      <div className="flex items-center gap-2">
      <code className="flex-1 truncate font-mono text-xs text-green-700 dark:text-green-400">
        {value}
      </code>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 flex-shrink-0"
              onClick={handleCopy}
              aria-label={copied ? "Copied to clipboard" : "Copy"}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{copied ? "Copied!" : "Copy"}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 flex-shrink-0 text-muted-foreground"
              onClick={onDismiss}
              aria-label="Dismiss"
            >
              ×
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Dismiss</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      </div>
    </div>
  );
}
