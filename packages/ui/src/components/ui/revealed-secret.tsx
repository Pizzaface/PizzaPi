import * as React from "react";
import { Button } from "@/components/ui/button";
import { Copy, Check } from "lucide-react";

/**
 * Banner shown once when a secret (API key / token) is first created.
 *
 * Displays the secret value with copy + dismiss buttons.
 * Replaces the identical banners in ApiKeyManager and RunnerTokenManager.
 */
export function RevealedSecretBanner({
  value,
  onDismiss,
}: {
  value: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-2 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2">
      <code className="flex-1 truncate font-mono text-xs text-green-700 dark:text-green-400">
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 flex-shrink-0"
        onClick={handleCopy}
        title="Copy"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-600" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 flex-shrink-0 text-muted-foreground"
        onClick={onDismiss}
        title="Dismiss"
      >
        ×
      </Button>
    </div>
  );
}
