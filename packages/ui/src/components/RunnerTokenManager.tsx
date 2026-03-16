import * as React from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Shield, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { RevealedSecretBanner } from "@/components/ui/revealed-secret";
import { Spinner } from "@/components/ui/spinner";

interface ApiKey {
  id: string;
  name: string | null;
  start: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  lastRequest: Date | null;
  enabled: boolean;
}

export function isRunnerKey(k: { name: string | null }): boolean {
  const name = (k.name ?? "").toLowerCase();
  return name === "runner" || name.startsWith("runner:") || name.startsWith("runner-");
}

function DeleteTokenButton({ onDelete, isDeleting }: { onDelete: () => void; isDeleting: boolean }) {
  const [confirming, setConfirming] = React.useState(false);

  React.useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(timer);
  }, [confirming]);

  if (isDeleting) {
    return (
      <Button variant="ghost" size="icon" className="h-7 w-7 flex-shrink-0 text-destructive" disabled>
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
        onClick={(e) => { e.stopPropagation(); onDelete(); setConfirming(false); }}
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
      onClick={(e) => { e.stopPropagation(); setConfirming(true); }}
      title="Revoke runner token"
      aria-label="Revoke runner token"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </Button>
  );
}

export function RunnerTokenManager({ onKeysChanged }: { onKeysChanged?: () => void } = {}) {
  const [keys, setKeys] = React.useState<ApiKey[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [newToken, setNewToken] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [deletingKeyId, setDeletingKeyId] = React.useState<string | null>(null);

  async function loadKeys() {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await authClient.$fetch<ApiKey[]>("/api-key/list");
      if (error) {
        setError((error as any)?.message ?? "Failed to load runner tokens");
        setKeys([]);
      } else {
        const list = (data ?? []).filter(isRunnerKey);
        setKeys(list);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load runner tokens");
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    loadKeys();
  }, []);

  async function createToken() {
    setCreating(true);
    setError(null);
    try {
      const { data, error } = await authClient.$fetch<ApiKey & { key: string }>("/api-key/create", {
        method: "POST",
        body: {
          name: "runner",
          prefix: "ppru",
        },
      });

      if (error) {
        setError((error as any)?.message ?? "Failed to create runner token");
        return;
      }

      const value = (data as any)?.key;
      setNewToken(typeof value === "string" ? value : null);
      await loadKeys();
      onKeysChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create runner token");
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
        setError((error as any)?.message ?? "Failed to revoke runner token");
      } else {
        await loadKeys();
        onKeysChanged?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke runner token");
    } finally {
      setDeletingKeyId(null);
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-muted-foreground" />
          <CardTitle>Runner Tokens</CardTitle>
        </div>
        <CardDescription>
          Tokens used by <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">pizzapi runner</code> to
          authenticate to the relay.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {newToken && (
          <RevealedSecretBanner
            value={newToken}
            onDismiss={() => setNewToken(null)}
          />
        )}

        <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs">
          <div className="font-semibold mb-1">How to use</div>
          <pre className="whitespace-pre-wrap font-mono text-[0.7rem] leading-relaxed text-muted-foreground">
{`export PIZZAPI_RELAY_URL=ws://localhost:7492
export PIZZAPI_API_KEY=<runner-token>
# Optional: constrain what folders the runner is allowed to open
export PIZZAPI_WORKSPACE_ROOT=/srv

bun run dev:runner`}
          </pre>
        </div>

        <div className="flex items-center justify-between gap-2">
          <Button onClick={createToken} disabled={creating}>
            <Plus className="h-4 w-4 mr-1" />
            {creating ? "Creating…" : keys.length > 0 ? "Create another" : "Create runner token"}
          </Button>
          <Button variant="outline" onClick={loadKeys} disabled={loading}>
            Refresh
          </Button>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No runner tokens yet.</p>
        ) : (
          <ScrollArea className="max-h-48">
            <div className="flex flex-col gap-1">
              {keys.map((k) => (
                <div
                  key={k.id}
                  className={cn(
                    "flex items-center gap-3 rounded-md border px-3 py-2",
                    !k.enabled && "opacity-50",
                  )}
                >
                  <Shield className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className="text-sm font-medium truncate">{k.name || "runner"}</span>
                    <span className="text-xs text-muted-foreground font-mono">
                      {k.start ? `${k.start}…` : ""}
                      {k.expiresAt
                        ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}`
                        : " · no expiry"}
                    </span>
                  </div>
                  <DeleteTokenButton
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
