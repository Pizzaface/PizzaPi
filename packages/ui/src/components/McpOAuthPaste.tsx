/**
 * MCP OAuth paste input — shown when an MCP server requires localhost redirect
 * and the user is accessing via remote web UI. The user completes OAuth in
 * their browser, then pastes the callback URL (which failed to load because
 * localhost is unreachable remotely) so we can extract the auth code.
 */

import React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ExternalLink, X, CheckCircle2, AlertCircle, KeyRound, Ban } from "lucide-react";
import { extractOAuthParams } from "./mcp-oauth-utils";

interface McpOAuthPasteProps {
  serverName: string;
  authUrl: string;
  nonce: string;
  /** Returns true if the code was sent, false if delivery failed (e.g. disconnected). */
  onSubmit: (nonce: string, code: string, state?: string) => boolean;
  onDismiss: (serverName: string) => void;
  /** Disable this MCP server (removes it from the active config). */
  onDisable?: (serverName: string) => void;
}

export function McpOAuthPaste({
  serverName,
  authUrl,
  nonce,
  onSubmit,
  onDismiss,
  onDisable,
}: McpOAuthPasteProps) {
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitted, setSubmitted] = React.useState(false);
  const [step, setStep] = React.useState<1 | 2>(1);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (step === 2) {
      inputRef.current?.focus();
    }
  }, [step]);

  const handleSubmit = () => {
    const { code, state } = extractOAuthParams(value);
    if (!code) {
      setError("Couldn't find an auth code in that URL. Copy the full URL from your browser's address bar — it should contain \"code=\".");
      return;
    }
    const sent = onSubmit(nonce, code, state ?? undefined);
    if (sent) {
      setError(null);
      setSubmitted(true);
    } else {
      setError("Not connected to the server. Wait for reconnection and try again.");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !submitted) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    // Auto-submit on paste if we can extract a code
    const pasted = e.clipboardData.getData("text");
    const { code, state } = extractOAuthParams(pasted);
    if (code) {
      e.preventDefault();
      setValue(pasted);
      const sent = onSubmit(nonce, code, state ?? undefined);
      if (sent) {
        setError(null);
        setSubmitted(true);
      } else {
        setError("Not connected to the server. Wait for reconnection and try again.");
      }
    }
  };

  if (submitted) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span>Authorization code sent — completing <strong>{serverName}</strong> authentication…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
      {/* Header */}
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex-1 text-sm font-medium text-amber-800 dark:text-amber-300">
          {serverName} needs authentication
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onDisable && (
            <button
              type="button"
              onClick={() => onDisable(serverName)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-amber-700 hover:bg-amber-500/20 dark:text-amber-400"
              title={`Disable ${serverName} MCP server`}
            >
              <Ban className="h-3 w-3" />
              <span>Disable</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onDismiss(serverName)}
            className="rounded p-0.5 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Step 1: Open auth link */}
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2 text-sm text-amber-800/80 dark:text-amber-300/80">
          <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-xs font-bold text-amber-700 dark:text-amber-300">1</span>
          <span>
            Click to sign in. After approving, you'll see an <strong>error page</strong> — that's expected.
          </span>
        </div>
        <a
          href={authUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setStep(2)}
          className="ml-7 inline-flex w-fit items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-amber-700 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400"
        >
          <ExternalLink className="h-3 w-3" />
          Sign in to {serverName}
        </a>
      </div>

      {/* Step 2: Paste the URL */}
      <div className={`flex flex-col gap-2 transition-opacity ${step === 1 ? "opacity-50" : "opacity-100"}`}>
        <div className="flex items-start gap-2 text-sm text-amber-800/80 dark:text-amber-300/80">
          <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-xs font-bold text-amber-700 dark:text-amber-300">2</span>
          <span>
            Copy the URL from the error page's address bar and paste it here:
          </span>
        </div>
        <div className="ml-7 flex gap-2">
          <Input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="http://localhost:1/callback?code=...&state=..."
            className="flex-1 font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
            disabled={step === 1}
          />
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!value.trim() || step === 1}
          >
            Submit
          </Button>
        </div>
        {error && (
          <div className="ml-7 flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </div>
  );
}
