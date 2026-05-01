import { useState } from "react";
import { Bolt, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { SectionProps } from "./RunnerSettingsPanel";

/** Extract nested value with fallback. */
function dig(obj: Record<string, any>, path: string[], fallback: any): any {
    let cur: any = obj;
    for (const key of path) {
        if (cur == null || typeof cur !== "object") return fallback;
        cur = cur[key];
    }
    return cur ?? fallback;
}

export default function OllamaWebSearchSettings({ config, onSave, saving }: SectionProps) {
    const ws = dig(config, ["providerSettings", "ollama-cloud", "webSearch"], {});

    const [enabled, setEnabled] = useState<boolean>(ws.enabled === true);
    const [maxResults, setMaxResults] = useState<number>(
        typeof ws.maxResults === "number" ? ws.maxResults : 5,
    );

    async function handleSave() {
        await onSave("webSearch", {
            "ollama-cloud": {
                webSearch: {
                    enabled,
                    maxResults,
                },
            },
        });
    }

    return (
        <div className="flex flex-col gap-6">
            {/* Header */}
            <div className="flex items-center gap-2">
                <Bolt className="h-5 w-5 text-muted-foreground" />
                <h3 className="text-sm font-medium">Ollama Cloud Web Search</h3>
            </div>

            {/* Enable toggle */}
            <div className="flex items-center justify-between rounded-md border border-border bg-card p-4">
                <div className="flex flex-col gap-1">
                    <Label htmlFor="ollama-ws-enabled" className="text-sm font-medium">
                        Enable Web Search
                    </Label>
                    <p className="text-xs text-muted-foreground">
                        Allow the agent to search the web during sessions using Ollama Cloud's web search API.
                        Requires an Ollama Cloud API key.
                    </p>
                </div>
                <Switch
                    id="ollama-ws-enabled"
                    checked={enabled}
                    onCheckedChange={setEnabled}
                />
            </div>

            {/* Max results */}
            <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
                <Label htmlFor="ollama-ws-max-results" className="text-sm font-medium">
                    Max Results Per Search
                </Label>
                <p className="text-xs text-muted-foreground">
                    Maximum number of search results returned per query (1–10).
                </p>
                <Input
                    id="ollama-ws-max-results"
                    type="number"
                    min={1}
                    max={10}
                    value={maxResults}
                    onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        if (!isNaN(v)) setMaxResults(Math.max(1, Math.min(10, v)));
                    }}
                    className="w-24"
                    disabled={!enabled}
                />
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between pt-2">
                <p className="text-xs text-muted-foreground italic">
                    Changes apply on next session start.
                </p>
                <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
                    <Save className="h-3.5 w-3.5" />
                    {saving ? "Saving…" : "Save"}
                </Button>
            </div>
        </div>
    );
}
