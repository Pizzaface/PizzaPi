import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import { cn } from "@/lib/utils";
import { Eye, EyeOff, Search, RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/input";

const STORAGE_KEY = "pp-hidden-models";

/** Read hidden model keys from localStorage (sync, used for initial render). */
export function loadHiddenModels(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((x: unknown): x is string => typeof x === "string"));
  } catch {}
  return new Set();
}

/** Persist hidden model keys to localStorage AND sync to server. */
export function saveHiddenModels(hidden: Set<string>): void {
  const arr = [...hidden];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch {}

  // Fire-and-forget server sync
  void fetch("/api/settings/hidden-models", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hiddenModels: arr }),
  }).catch(() => {});
}

/**
 * Fetch hidden models from the server and merge with localStorage.
 * Returns the authoritative set and updates localStorage to match.
 */
export async function fetchHiddenModels(): Promise<Set<string>> {
  try {
    const res = await fetch("/api/settings/hidden-models", { credentials: "include" });
    if (res.ok) {
      const data = await res.json();
      const arr: string[] = Array.isArray(data?.hiddenModels)
        ? (data.hiddenModels as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const models = new Set<string>(arr);
      // Update localStorage to stay in sync
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...models])); } catch {}
      return models;
    }
  } catch {}
  // Fallback to localStorage if server is unreachable
  return loadHiddenModels();
}

/** Build a model key for the hidden set. */
export function modelKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
}

export interface HiddenModelsManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All models known across sessions/runners. */
  models: ModelInfo[];
  /** Current hidden model keys. */
  hiddenModels: Set<string>;
  /** Called when the hidden set changes. */
  onHiddenModelsChange: (hidden: Set<string>) => void;
}

export function HiddenModelsManager({
  open,
  onOpenChange,
  models,
  hiddenModels,
  onHiddenModelsChange,
}: HiddenModelsManagerProps) {
  const [search, setSearch] = React.useState("");

  // Reset search when dialog opens
  React.useEffect(() => {
    if (open) setSearch("");
  }, [open]);

  // Group models by provider
  const groups = React.useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const model of models) {
      if (!map.has(model.provider)) map.set(model.provider, []);
      map.get(model.provider)!.push(model);
    }
    // Sort providers alphabetically
    return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }, [models]);

  // Filter by search
  const filteredGroups = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;

    const result = new Map<string, ModelInfo[]>();
    for (const [provider, providerModels] of groups) {
      const filtered = providerModels.filter(
        (m) =>
          m.provider.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          (m.name?.toLowerCase().includes(q) ?? false)
      );
      if (filtered.length > 0) result.set(provider, filtered);
    }
    return result;
  }, [groups, search]);

  const toggleModel = React.useCallback(
    (key: string) => {
      const next = new Set(hiddenModels);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      saveHiddenModels(next);
      onHiddenModelsChange(next);
    },
    [hiddenModels, onHiddenModelsChange]
  );

  const toggleProvider = React.useCallback(
    (provider: string, providerModels: ModelInfo[]) => {
      const keys = providerModels.map((m) => modelKey(m.provider, m.id));
      const allHidden = keys.every((k) => hiddenModels.has(k));
      const next = new Set(hiddenModels);

      if (allHidden) {
        // Show all models for this provider
        for (const k of keys) next.delete(k);
      } else {
        // Hide all models for this provider
        for (const k of keys) next.add(k);
      }

      saveHiddenModels(next);
      onHiddenModelsChange(next);
    },
    [hiddenModels, onHiddenModelsChange]
  );

  const showAll = React.useCallback(() => {
    saveHiddenModels(new Set());
    onHiddenModelsChange(new Set());
  }, [onHiddenModelsChange]);

  const hiddenCount = models.filter((m) => hiddenModels.has(modelKey(m.provider, m.id))).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Model Visibility</DialogTitle>
          <DialogDescription>
            Choose which models appear in the model selector. Hidden models won't show up when switching models in any session.
          </DialogDescription>
        </DialogHeader>

        {/* Search + reset */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search models…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 text-sm"
            />
          </div>
          {hiddenCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={showAll}
              className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground flex-shrink-0"
            >
              <RotateCcw className="h-3 w-3" />
              Show all ({hiddenCount} hidden)
            </Button>
          )}
        </div>

        {/* Model list */}
        <ScrollArea className="flex-1 -mx-6 px-6 min-h-0">
          {filteredGroups.size === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {models.length === 0
                ? "No models available. Connect to a session to see available models."
                : "No models match your search."}
            </div>
          ) : (
            <div className="flex flex-col gap-1 pb-2">
              {Array.from(filteredGroups.entries()).map(([provider, providerModels], groupIdx) => {
                const providerKeys = providerModels.map((m) => modelKey(m.provider, m.id));
                const hiddenInProvider = providerKeys.filter((k) => hiddenModels.has(k)).length;
                const allHidden = hiddenInProvider === providerModels.length;
                const someHidden = hiddenInProvider > 0 && !allHidden;

                return (
                  <React.Fragment key={provider}>
                    {groupIdx > 0 && <Separator className="my-1" />}

                    {/* Provider header with toggle-all */}
                    <button
                      type="button"
                      onClick={() => toggleProvider(provider, providerModels)}
                      className={cn(
                        "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left transition-colors",
                        "hover:bg-muted/60 group"
                      )}
                    >
                      <ModelSelectorLogo provider={provider} className="flex-shrink-0" />
                      <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {provider}
                      </span>
                      <span className="text-[10px] text-muted-foreground/70 mr-1">
                        {hiddenInProvider > 0 && (
                          <span className="text-amber-500 dark:text-amber-400">
                            {hiddenInProvider} hidden
                          </span>
                        )}
                      </span>
                      <span
                        className={cn(
                          "flex-shrink-0 transition-colors",
                          allHidden
                            ? "text-muted-foreground/50"
                            : someHidden
                              ? "text-amber-500 dark:text-amber-400"
                              : "text-foreground/70"
                        )}
                        title={allHidden ? "Show all models in this provider" : "Hide all models in this provider"}
                      >
                        {allHidden ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </span>
                    </button>

                    {/* Individual models */}
                    <div className="flex flex-col">
                      {providerModels.map((model) => {
                        const key = modelKey(model.provider, model.id);
                        const isHidden = hiddenModels.has(key);

                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => toggleModel(key)}
                            className={cn(
                              "flex items-center gap-2.5 w-full px-2 py-1.5 pl-7 rounded-md text-left transition-colors",
                              "hover:bg-muted/60",
                              isHidden && "opacity-50"
                            )}
                          >
                            <span className="flex-1 min-w-0">
                              <span className={cn("text-sm", isHidden && "line-through decoration-muted-foreground/40")}>
                                {model.name || model.id}
                              </span>
                              {model.name && model.name !== model.id && (
                                <span className="ml-1.5 text-xs text-muted-foreground">{model.id}</span>
                              )}
                            </span>
                            <span
                              className={cn(
                                "flex-shrink-0 transition-colors",
                                isHidden ? "text-muted-foreground/40" : "text-foreground/70"
                              )}
                            >
                              {isHidden ? (
                                <EyeOff className="h-3.5 w-3.5" />
                              ) : (
                                <Eye className="h-3.5 w-3.5" />
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
