import { useState, type KeyboardEvent } from "react";
import { Globe, Bolt, Plus, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
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

export default function WebSearchSettings({ config, onSave, saving }: SectionProps) {
    const anthropicWs = dig(config, ["providerSettings", "anthropic", "webSearch"], {});
    const ollamaWs = dig(config, ["providerSettings", "ollama-cloud", "webSearch"], {});

    // ── Anthropic state ──────────────────────────────────────────────────
    const [enabled, setEnabled] = useState<boolean>(anthropicWs.enabled === true);
    const [maxUses, setMaxUses] = useState<number>(typeof anthropicWs.maxUses === "number" ? anthropicWs.maxUses : 5);
    const [allowedDomains, setAllowedDomains] = useState<string[]>(
        Array.isArray(anthropicWs.allowedDomains) ? anthropicWs.allowedDomains : [],
    );
    const [blockedDomains, setBlockedDomains] = useState<string[]>(
        Array.isArray(anthropicWs.blockedDomains) ? anthropicWs.blockedDomains : [],
    );

    // ── Ollama Cloud state ────────────────────────────────────────────────
    const [ollamaEnabled, setOllamaEnabled] = useState<boolean>(ollamaWs.enabled === true);
    const [ollamaMaxResults, setOllamaMaxResults] = useState<number>(
        typeof ollamaWs.maxResults === "number" ? ollamaWs.maxResults : 5,
    );
    const [ollamaMaxContentChars, setOllamaMaxContentChars] = useState<number>(
        typeof ollamaWs.maxContentChars === "number" ? ollamaWs.maxContentChars : 8000,
    );
    const [ollamaMaxLinks, setOllamaMaxLinks] = useState<number>(
        typeof ollamaWs.maxLinks === "number" ? ollamaWs.maxLinks : 100,
    );

    // Inputs for adding domains
    const [allowedInput, setAllowedInput] = useState("");
    const [blockedInput, setBlockedInput] = useState("");

    function addDomain(
        value: string,
        list: string[],
        setList: (v: string[]) => void,
        setInput: (v: string) => void,
    ) {
        const trimmed = value.trim().toLowerCase();
        if (!trimmed || list.includes(trimmed)) return;
        setList([...list, trimmed]);
        setInput("");
    }

    function removeDomain(index: number, list: string[], setList: (v: string[]) => void) {
        setList(list.filter((_, i) => i !== index));
    }

    function handleKeyDown(
        e: KeyboardEvent<HTMLInputElement>,
        value: string,
        list: string[],
        setList: (v: string[]) => void,
        setInput: (v: string) => void,
    ) {
        if (e.key === "Enter") {
            e.preventDefault();
            addDomain(value, list, setList, setInput);
        }
    }

    async function handleSave() {
        await onSave("webSearch", {
            anthropic: {
                webSearch: {
                    enabled,
                    maxUses,
                    allowedDomains,
                    blockedDomains,
                },
            },
            "ollama-cloud": {
                webSearch: {
                    enabled: ollamaEnabled,
                    maxResults: ollamaMaxResults,
                    maxContentChars: ollamaMaxContentChars,
                    maxLinks: ollamaMaxLinks,
                },
            },
        });
    }

    return (
        <div className="flex flex-col gap-6">
            {/* ── Anthropic section ─────────────────────────────────────── */}
            <div className="flex flex-col gap-4">
                <div className="flex items-center gap-2">
                    <Globe className="h-5 w-5 text-muted-foreground" />
                    <h3 className="text-sm font-medium">Anthropic</h3>
                </div>

                {/* Enable toggle */}
                <div className="flex items-center justify-between rounded-md border border-border bg-card p-4">
                    <div className="flex flex-col gap-1">
                        <Label htmlFor="ws-enabled" className="text-sm font-medium">
                            Enable Web Search
                        </Label>
                        <p className="text-xs text-muted-foreground">
                            Allow the agent to search the web using Anthropic's built-in web search tool.
                        </p>
                    </div>
                    <Switch id="ws-enabled" checked={enabled} onCheckedChange={setEnabled} />
                </div>

                {/* Max uses */}
                <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
                    <Label htmlFor="ws-max-uses" className="text-sm font-medium">
                        Max Uses Per Turn
                    </Label>
                    <p className="text-xs text-muted-foreground">
                        Maximum number of web searches per conversation turn (1–20).
                    </p>
                    <Input
                        id="ws-max-uses"
                        type="number"
                        min={1}
                        max={20}
                        value={maxUses}
                        onChange={(e) => {
                            const v = parseInt(e.target.value, 10);
                            if (!isNaN(v)) setMaxUses(Math.max(1, Math.min(20, v)));
                        }}
                        className="w-24"
                        disabled={!enabled}
                    />
                </div>

                {/* Allowed domains */}
                <DomainListField
                    id="allowed"
                    label="Allowed Domains"
                    description="Restrict searches to only these domains. Leave empty to allow all domains."
                    domains={allowedDomains}
                    inputValue={allowedInput}
                    onInputChange={setAllowedInput}
                    onAdd={() => addDomain(allowedInput, allowedDomains, setAllowedDomains, setAllowedInput)}
                    onRemove={(i) => removeDomain(i, allowedDomains, setAllowedDomains)}
                    onKeyDown={(e) =>
                        handleKeyDown(e, allowedInput, allowedDomains, setAllowedDomains, setAllowedInput)
                    }
                    disabled={!enabled}
                    placeholder="e.g. docs.anthropic.com"
                />

                {/* Blocked domains */}
                <DomainListField
                    id="blocked"
                    label="Blocked Domains"
                    description="Exclude these domains from search results."
                    domains={blockedDomains}
                    inputValue={blockedInput}
                    onInputChange={setBlockedInput}
                    onAdd={() => addDomain(blockedInput, blockedDomains, setBlockedDomains, setBlockedInput)}
                    onRemove={(i) => removeDomain(i, blockedDomains, setBlockedDomains)}
                    onKeyDown={(e) =>
                        handleKeyDown(e, blockedInput, blockedDomains, setBlockedDomains, setBlockedInput)
                    }
                    disabled={!enabled}
                    placeholder="e.g. reddit.com"
                />
            </div>

            {/* Divider */}
            <div className="border-t border-border" />

            {/* ── Ollama Cloud section ──────────────────────────────────── */}
            <div className="flex flex-col gap-4">
                <div className="flex items-center gap-2">
                    <Bolt className="h-5 w-5 text-muted-foreground" />
                    <h3 className="text-sm font-medium">Ollama Cloud</h3>
                </div>

                {/* Enable toggle */}
                <div className="flex items-center justify-between rounded-md border border-border bg-card p-4">
                    <div className="flex flex-col gap-1">
                        <Label htmlFor="ollama-ws-enabled" className="text-sm font-medium">
                            Enable Web Search
                        </Label>
                        <p className="text-xs text-muted-foreground">
                            Register Ollama Cloud web search and web fetch tools. Requires an Ollama Cloud API key.
                        </p>
                    </div>
                    <Switch id="ollama-ws-enabled" checked={ollamaEnabled} onCheckedChange={setOllamaEnabled} />
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
                        value={ollamaMaxResults}
                        onChange={(e) => {
                            const v = parseInt(e.target.value, 10);
                            if (!isNaN(v)) setOllamaMaxResults(Math.max(1, Math.min(10, v)));
                        }}
                        className="w-24"
                        disabled={!ollamaEnabled}
                    />
                </div>

                {/* Max content chars (web fetch) */}
                <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
                    <Label htmlFor="ollama-ws-max-content-chars" className="text-sm font-medium">
                        Web Fetch — Max Content Chars
                    </Label>
                    <p className="text-xs text-muted-foreground">
                        Truncate fetched page content to this many characters (1–100,000).
                    </p>
                    <Input
                        id="ollama-ws-max-content-chars"
                        type="number"
                        min={1}
                        max={100000}
                        value={ollamaMaxContentChars}
                        onChange={(e) => {
                            const v = parseInt(e.target.value, 10);
                            if (!isNaN(v)) setOllamaMaxContentChars(Math.max(1, Math.min(100000, v)));
                        }}
                        className="w-28"
                        disabled={!ollamaEnabled}
                    />
                </div>

                {/* Max links (web fetch) */}
                <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
                    <Label htmlFor="ollama-ws-max-links" className="text-sm font-medium">
                        Web Fetch — Max Links
                    </Label>
                    <p className="text-xs text-muted-foreground">
                        Truncate fetched page links to this many entries (1–1,000).
                    </p>
                    <Input
                        id="ollama-ws-max-links"
                        type="number"
                        min={1}
                        max={1000}
                        value={ollamaMaxLinks}
                        onChange={(e) => {
                            const v = parseInt(e.target.value, 10);
                            if (!isNaN(v)) setOllamaMaxLinks(Math.max(1, Math.min(1000, v)));
                        }}
                        className="w-28"
                        disabled={!ollamaEnabled}
                    />
                </div>
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

/* ── Domain list sub-component ─────────────────────────────────────────────── */

interface DomainListFieldProps {
    id: string;
    label: string;
    description: string;
    domains: string[];
    inputValue: string;
    onInputChange: (v: string) => void;
    onAdd: () => void;
    onRemove: (index: number) => void;
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
    disabled: boolean;
    placeholder: string;
}

function DomainListField({
    id,
    label,
    description,
    domains,
    inputValue,
    onInputChange,
    onAdd,
    onRemove,
    onKeyDown,
    disabled,
    placeholder,
}: DomainListFieldProps) {
    return (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
            <Label className="text-sm font-medium">{label}</Label>
            <p className="text-xs text-muted-foreground">{description}</p>

            <div className="flex gap-2">
                <Input
                    id={`ws-${id}-input`}
                    value={inputValue}
                    onChange={(e) => onInputChange(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder={placeholder}
                    disabled={disabled}
                    className="flex-1"
                />
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onAdd}
                    disabled={disabled || !inputValue.trim()}
                    className="gap-1 shrink-0"
                >
                    <Plus className="h-3.5 w-3.5" />
                    Add
                </Button>
            </div>

            {domains.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                    {domains.map((domain, i) => (
                        <Badge
                            key={domain}
                            variant="secondary"
                            className={cn(
                                "gap-1 pl-2 pr-1 py-0.5",
                                disabled && "opacity-50",
                            )}
                        >
                            {domain}
                            <button
                                type="button"
                                onClick={() => onRemove(i)}
                                disabled={disabled}
                                className="rounded-full p-0.5 hover:bg-muted-foreground/20 transition-colors"
                                aria-label={`Remove ${domain}`}
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </Badge>
                    ))}
                </div>
            )}
        </div>
    );
}
