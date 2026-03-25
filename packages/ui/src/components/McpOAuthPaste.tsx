/**
 * MCP OAuth paste input — shown when an MCP server requires localhost redirect
 * and the user is accessing via remote web UI. The user completes OAuth in
 * their browser, then pastes the callback URL (which failed to load because
 * localhost is unreachable remotely) so we can extract the auth code.
 */

import React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ClipboardPaste, X, CheckCircle2, AlertCircle } from "lucide-react";

interface McpOAuthPasteProps {
  serverName: string;
  nonce: string;
  onSubmit: (nonce: string, code: string) => void;
  onDismiss: (serverName: string) => void;
}

/**
 * Extract the OAuth `code` parameter from a pasted callback URL.
 * Accepts full URLs (http://localhost:1/callback?code=ABC&state=XYZ)
 * or just query strings (?code=ABC&state=XYZ).
 */
function extractCodeFromUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    // Try parsing as a full URL first
    const url = new URL(trimmed);
    return url.searchParams.get("code");
  } catch {
    // Not a valid URL — try as a query string
    if (trimmed.includes("code=")) {
      const params = new URLSearchParams(
        trimmed.startsWith("?") ? trimmed : `?${trimmed}`,
      );
      return params.get("code");
    }
    return null;
  }
}

export function McpOAuthPaste({
  serverName,
  nonce,
  onSubmit,
  onDismiss,
}: McpOAuthPasteProps) {
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitted, setSubmitted] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    // Auto-focus the input when the component mounts
    inputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    const code = extractCodeFromUrl(value);
    if (!code) {
      setError("Could not find an authorization code in the pasted URL. Make sure you copied the full URL from your browser's address bar.");
      return;
    }
    setError(null);
    setSubmitted(true);
    onSubmit(nonce, code);
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
    const code = extractCodeFromUrl(pasted);
    if (code) {
      e.preventDefault();
      setValue(pasted);
      setError(null);
      setSubmitted(true);
      onSubmit(nonce, code);
    }
  };

  if (submitted) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span>Authorization code sent to <strong>{serverName}</strong> — completing authentication…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
      <div className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-300">
        <ClipboardPaste className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <strong>{serverName}</strong> redirected to localhost which isn't reachable remotely.
          Paste the URL from your browser's address bar:
        </span>
        <button
          type="button"
          onClick={() => onDismiss(serverName)}
          className="ml-auto shrink-0 rounded p-0.5 hover:bg-amber-500/20"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex gap-2">
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
        />
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!value.trim()}
        >
          Submit
        </Button>
      </div>
      {error && (
        <div className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
