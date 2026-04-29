import { useEffect, useMemo, useState } from "react";
import { Info, Loader2, Save, Search, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ErrorAlert } from "@/components/ui/error-alert";
import type { SectionProps } from "./RunnerSettingsPanel";
import { formatMcpReloadMessage, type McpReloadResult } from "@/components/mcp-reload-status";

export default function ToolSearchSettings({ runnerId, config, onSave, saving }: SectionProps) {
  const toolSearch = useMemo(() => {
    const raw = config.toolSearch;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  }, [config.toolSearch]);

  const [enabled, setEnabled] = useState<boolean>(toolSearch.enabled === true);
  const [tokenThreshold, setTokenThreshold] = useState<number>(
    typeof toolSearch.tokenThreshold === "number" ? Math.max(0, Math.floor(toolSearch.tokenThreshold)) : 10000,
  );
  const [maxResults, setMaxResults] = useState<number>(
    typeof toolSearch.maxResults === "number" ? Math.max(1, Math.floor(toolSearch.maxResults)) : 5,
  );
  const [keepLoadedTools, setKeepLoadedTools] = useState<boolean>(toolSearch.keepLoadedTools !== false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadResult, setReloadResult] = useState<McpReloadResult | null>(null);

  useEffect(() => {
    setEnabled(toolSearch.enabled === true);
    setTokenThreshold(
      typeof toolSearch.tokenThreshold === "number" ? Math.max(0, Math.floor(toolSearch.tokenThreshold)) : 10000,
    );
    setMaxResults(
      typeof toolSearch.maxResults === "number" ? Math.max(1, Math.floor(toolSearch.maxResults)) : 5,
    );
    setKeepLoadedTools(toolSearch.keepLoadedTools !== false);
  }, [toolSearch]);

  const isDirty =
    enabled !== (toolSearch.enabled === true) ||
    tokenThreshold !== (typeof toolSearch.tokenThreshold === "number" ? Math.max(0, Math.floor(toolSearch.tokenThreshold)) : 10000) ||
    maxResults !== (typeof toolSearch.maxResults === "number" ? Math.max(1, Math.floor(toolSearch.maxResults)) : 5) ||
    keepLoadedTools !== (toolSearch.keepLoadedTools !== false);

  async function handleSave() {
    setError(null);
    setSuccessMessage(null);
    setReloadResult(null);
    try {
      await onSave("toolSearch", {
        enabled,
        tokenThreshold,
        maxResults,
        keepLoadedTools,
      });
      setSuccessMessage("Tool Search settings saved. Reload MCP in active sessions to apply changes immediately.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleReloadActiveSessions() {
    setReloading(true);
    setError(null);
    try {
      const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/mcp/reload`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = await res.json() as McpReloadResult;
      setReloadResult(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReloading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <ErrorAlert>{error}</ErrorAlert>}

      <div className="flex items-center gap-2">
        <Search className="h-5 w-5 text-muted-foreground" />
        <h3 className="text-sm font-medium">Tool Search</h3>
      </div>

      <div className="flex items-center justify-between rounded-md border border-border bg-card p-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="tool-search-enabled" className="text-sm font-medium">
            Enable Tool Search
          </Label>
          <p className="text-xs text-muted-foreground">
            Defer MCP tools when they would take too much context, and expose them to the agent through <code>search_tools</code>.
          </p>
        </div>
        <Switch id="tool-search-enabled" checked={enabled} onCheckedChange={setEnabled} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
          <Label htmlFor="tool-search-threshold" className="text-sm font-medium">
            Token Threshold (chars)
          </Label>
          <p className="text-xs text-muted-foreground">
            When total MCP tool definitions exceed this character count, unpinned tools are deferred.
          </p>
          <Input
            id="tool-search-threshold"
            type="number"
            min={0}
            step={1}
            value={tokenThreshold}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              setTokenThreshold(Number.isFinite(next) ? Math.max(0, next) : 0);
            }}
            disabled={!enabled}
            className="w-36"
          />
        </div>

        <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
          <Label htmlFor="tool-search-max-results" className="text-sm font-medium">
            Max Results
          </Label>
          <p className="text-xs text-muted-foreground">
            Maximum number of deferred MCP tools returned from a single <code>search_tools</code> call.
          </p>
          <Input
            id="tool-search-max-results"
            type="number"
            min={1}
            max={50}
            step={1}
            value={maxResults}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              setMaxResults(Number.isFinite(next) ? Math.max(1, Math.min(50, next)) : 1);
            }}
            disabled={!enabled}
            className="w-28"
          />
        </div>
      </div>

      <div className="flex items-center justify-between rounded-md border border-border bg-card p-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="tool-search-keep-loaded" className="text-sm font-medium">
            Keep Loaded Tools Active
          </Label>
          <p className="text-xs text-muted-foreground">
            When enabled, tools discovered through <code>search_tools</code> stay loaded for the rest of the session.
          </p>
        </div>
        <Switch
          id="tool-search-keep-loaded"
          checked={keepLoadedTools}
          onCheckedChange={setKeepLoadedTools}
          disabled={!enabled}
        />
      </div>

      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <span>
          Future sessions pick up these settings automatically. Use Reload MCP below to apply changes to active sessions now.
        </span>
      </div>

      {successMessage && (
        <div className="rounded-md border border-green-500/30 bg-green-500/5 px-4 py-3 text-sm text-green-400">
          {successMessage}
        </div>
      )}

      {reloadResult && (
        <div className="rounded-md border border-blue-500/30 bg-blue-500/5 px-4 py-3 text-sm text-blue-300">
          {formatMcpReloadMessage(reloadResult)}
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <div className="text-xs text-muted-foreground italic">
          Save updates config. Reload MCP applies them to currently active sessions.
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleReloadActiveSessions}
            disabled={reloading}
            className="gap-1.5"
          >
            {reloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Reload MCP
          </Button>
          <Button onClick={handleSave} disabled={saving || !isDirty} size="sm" className="gap-1.5">
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
