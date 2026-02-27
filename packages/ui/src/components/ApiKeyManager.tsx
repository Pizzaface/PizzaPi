import * as React from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Trash2, Plus, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { RevealedSecretBanner } from "@/components/ui/revealed-secret";
import { Spinner } from "@/components/ui/spinner";

function DeleteKeyButton({ onDelete, isDeleting }: { onDelete: () => void; isDeleting: boolean }) {
    const [confirming, setConfirming] = React.useState(false);

    React.useEffect(() => {
        if (!confirming) return;
        const timer = setTimeout(() => setConfirming(false), 3000);
        return () => clearTimeout(timer);
    }, [confirming]);

    if (isDeleting) {
        return (
            <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 flex-shrink-0 text-destructive"
                disabled
            >
                <Spinner className="h-3.5 w-3.5" />
            </Button>
        );
    }

    if (confirming) {
        return (
            <Button
                variant="destructive"
                size="sm"
                className="h-7 px-2 text-xs animate-in fade-in zoom-in duration-200"
                onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                    setConfirming(false);
                }}
            >
                Sure?
            </Button>
        );
    }

    return (
        <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 flex-shrink-0 text-muted-foreground hover:text-destructive transition-colors"
            onClick={(e) => {
                e.stopPropagation();
                setConfirming(true);
            }}
            title="Revoke key"
            aria-label="Revoke key"
        >
            <Trash2 className="h-3.5 w-3.5" />
        </Button>
    );
}

interface ApiKey {
    id: string;
    name: string | null;
    start: string | null;
    createdAt: Date;
    expiresAt: Date | null;
    lastRequest: Date | null;
    enabled: boolean;
}

export function ApiKeyManager() {
    const [keys, setKeys] = React.useState<ApiKey[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [creating, setCreating] = React.useState(false);
    const [newKeyName, setNewKeyName] = React.useState("");
    const [newKeyValue, setNewKeyValue] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [deletingKeyId, setDeletingKeyId] = React.useState<string | null>(null);

    async function loadKeys() {
        setLoading(true);
        try {
            const { data, error } = await authClient.$fetch<ApiKey[]>("/api-key/list");
            if (error) {
                setError((error as any)?.message ?? "Failed to load API keys");
            } else {
                setKeys(data ?? []);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to load API keys");
        } finally {
            setLoading(false);
        }
    }

    React.useEffect(() => {
        loadKeys();
    }, []);

    async function handleCreate(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setCreating(true);
        try {
            const { data, error } = await authClient.$fetch<ApiKey & { key: string }>("/api-key/create", {
                method: "POST",
                body: { name: newKeyName || undefined, prefix: "pzpe" },
            });
            if (error) {
                setError((error as any)?.message ?? "Failed to create API key");
            } else {
                setNewKeyValue((data as any)?.key ?? null);
                setNewKeyName("");
                await loadKeys();
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to create API key");
        } finally {
            setCreating(false);
        }
    }

    async function handleDelete(id: string) {
        setError(null);
        setDeletingKeyId(id);
        try {
            const { error } = await authClient.$fetch("/api-key/delete", {
                method: "POST",
                body: { keyId: id },
            });
            if (error) {
                setError((error as any)?.message ?? "Failed to delete API key");
            } else {
                await loadKeys();
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to delete API key");
        } finally {
            setDeletingKeyId(null);
        }
    }

    return (
        <Card className="w-full">
            <CardHeader>
                <div className="flex items-center gap-2">
                    <KeyRound className="h-5 w-5 text-muted-foreground" />
                    <CardTitle>API Keys</CardTitle>
                </div>
                <CardDescription>
                    Create API keys to authenticate programmatic access. Pass them as the{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">x-api-key</code> header.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                {/* New key revealed banner */}
                {newKeyValue && (
                    <RevealedSecretBanner
                        value={newKeyValue}
                        onDismiss={() => setNewKeyValue(null)}
                    />
                )}
                {newKeyValue && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                        Copy this key now — it won't be shown again.
                    </p>
                )}

                {/* Create form */}
                <form onSubmit={handleCreate} className="flex items-end gap-2">
                    <div className="flex flex-col gap-1.5 flex-1">
                        <Label htmlFor="key-name">New key name</Label>
                        <Input
                            id="key-name"
                            placeholder="e.g. my-script"
                            value={newKeyName}
                            onChange={(e) => setNewKeyName(e.target.value)}
                        />
                    </div>
                    <Button type="submit" disabled={creating} className="flex-shrink-0 min-w-[80px]">
                        {creating ? (
                            <Spinner className="h-4 w-4" />
                        ) : (
                            <>
                                <Plus className="h-4 w-4 mr-1" /> Create
                            </>
                        )}
                    </Button>
                </form>

                {error && (
                    <p className="text-sm text-destructive" role="alert" aria-live="polite">
                        {error}
                    </p>
                )}

                {/* Key list */}
                {loading ? (
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                    </div>
                ) : keys.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic">No API keys yet.</p>
                ) : (
                    <ScrollArea className="max-h-64">
                        <div className="flex flex-col gap-1">
                            {keys.map((k) => (
                                <div
                                    key={k.id}
                                    className={cn(
                                        "flex items-center gap-3 rounded-md border px-3 py-2",
                                        !k.enabled && "opacity-50",
                                    )}
                                >
                                    <KeyRound className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                                    <div className="flex flex-col flex-1 min-w-0">
                                        <span className="text-sm font-medium truncate">
                                            {k.name || "Unnamed key"}
                                        </span>
                                        <span className="text-xs text-muted-foreground font-mono">
                                            {k.start ? `${k.start}…` : ""}
                                            {k.expiresAt
                                                ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}`
                                                : " · no expiry"}
                                        </span>
                                    </div>
                                    <DeleteKeyButton
                                        onDelete={() => handleDelete(k.id)}
                                        isDeleting={deletingKeyId === k.id}
                                    />
                                </div>
                            ))}
                        </div>
                    </ScrollArea>
                )}
            </CardContent>
        </Card>
    );
}
