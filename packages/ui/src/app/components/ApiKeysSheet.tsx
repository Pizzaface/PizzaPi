import { Suspense } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  LazyApiKeyManager,
  LazyDeviceSetupScanner,
  LazyMobileSetupQR,
  LazyRunnerTokenManager,
  PanelFallback,
} from "../lazy-surfaces";

/**
 * Right-hand API keys sheet (hand-rolled overlay, not a Radix Dialog —
 * Escape-to-close is wired at the document level by useAppDialogs).
 */
export function ApiKeysSheet({
  apiKeyVersion,
  onKeysChanged,
  onClose,
}: {
  apiKeyVersion: number;
  onKeysChanged: () => void;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="API Keys"
      className="absolute inset-y-0 right-0 z-40 flex w-full max-w-md flex-col shadow-xl border-l bg-background"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <span className="font-semibold text-sm">API Keys</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onClose}
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <Suspense fallback={<PanelFallback label="API keys" />}>
          <div className="flex flex-col gap-4">
            <LazyMobileSetupQR />
            <LazyApiKeyManager refreshSignal={apiKeyVersion} onKeysChanged={onKeysChanged} />
            <LazyRunnerTokenManager refreshSignal={apiKeyVersion} onKeysChanged={onKeysChanged} />
            <LazyDeviceSetupScanner onClose={onClose} />
          </div>
        </Suspense>
      </div>
    </div>
  );
}
