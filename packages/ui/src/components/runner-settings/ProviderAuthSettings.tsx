import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, KeyRound, Loader2, LogIn, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorAlert } from "@/components/ui/error-alert";
import type { SectionProps } from "./RunnerSettingsPanel";

interface ProviderRow {
    id: string;
    name: string;
    types: ("oauth" | "api_key")[];
    configured: boolean;
}

type LoginStep =
    | { state: "waiting" }
    | {
        state: "prompt";
        loginId: string;
        prompt: { type: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string; options?: { id: string; label: string }[] };
        authUrl?: string;
        info?: string[];
    }
    | { state: "done"; providerId: string }
    | { state: "error"; message: string };

async function api(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return body;
}

export default function ProviderAuthSettings({ runnerId }: SectionProps) {
    const base = `/api/runners/${encodeURIComponent(runnerId)}/providers`;
    const [providers, setProviders] = useState<ProviderRow[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [step, setStep] = useState<LoginStep | null>(null);
    const [answer, setAnswer] = useState("");
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        setError(null);
        try {
            const body = await api(base);
            setProviders(body.providers ?? []);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [base]);

    useEffect(() => {
        void load();
    }, [load]);

    /**
     * While a prompt is on screen, the provider's own loopback callback may
     * complete the login (browser on the runner's host, or 53692 published from
     * the container) — nothing submits in that case, so poll for the outcome.
     */
    useEffect(() => {
        if (step?.state !== "prompt") return;
        const loginId = step.loginId;
        const timer = setInterval(async () => {
            try {
                const body = await api(`${base}/login/status?loginId=${encodeURIComponent(loginId)}`);
                if (body.step?.state === "done" || body.step?.state === "error") applyStep(body.step);
            } catch {
                // Transient relay/runner hiccup — the next tick retries.
            }
        }, 2500);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, base]);

    /** Both start and submit return the same "what's next" step. */
    function applyStep(next: LoginStep) {
        setAnswer("");
        if (next.state === "waiting") {
            return;
        }
        if (next.state === "done") {
            setStep(null);
            setNotice(`${next.providerId} is now authenticated.`);
            void load();
        } else if (next.state === "error") {
            setStep(null);
            setError(next.message);
        } else {
            setStep(next);
        }
    }

    async function start(providerId: string, authType: "oauth" | "api_key") {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const body = await api(`${base}/login`, { method: "POST", body: JSON.stringify({ providerId, authType }) });
            applyStep(body.step);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function submit(value: string) {
        if (!step || step.state !== "prompt") return;
        setBusy(true);
        setError(null);
        try {
            const body = await api(`${base}/login/submit`, {
                method: "POST",
                body: JSON.stringify({ loginId: step.loginId, value }),
            });
            applyStep(body.step);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setStep(null);
        } finally {
            setBusy(false);
        }
    }

    async function cancel() {
        const loginId = step?.state === "prompt" ? step.loginId : null;
        setStep(null);
        setAnswer("");
        if (loginId) {
            await api(`${base}/login/cancel`, { method: "POST", body: JSON.stringify({ loginId }) }).catch(() => {});
        }
    }

    return (
        <div className="p-4 space-y-4">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h3 className="text-sm font-medium">Model providers</h3>
                    <p className="text-xs text-muted-foreground mt-1">
                        Credentials are stored on the runner in <code>auth.json</code>. New sessions pick them up
                        immediately.
                    </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
                    <RefreshCw className="h-3.5 w-3.5 mr-1" />
                    Refresh
                </Button>
            </div>

            {error && <ErrorAlert>{error}</ErrorAlert>}
            {notice && (
                <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {notice}
                </div>
            )}

            {step?.state === "prompt" && (
                <div className="rounded-md border p-3 space-y-3">
                    {step.authUrl && (
                        <div className="space-y-2">
                            <p className="text-xs text-muted-foreground">
                                Open the authorization page, finish signing in, then paste the URL you land on back
                                here. It can be a browser on any device.
                            </p>
                            <Button asChild size="sm" variant="secondary">
                                <a href={step.authUrl} target="_blank" rel="noreferrer">
                                    <ExternalLink className="h-3.5 w-3.5 mr-1" />
                                    Open authorization page
                                </a>
                            </Button>
                        </div>
                    )}
                    {step.info?.map((line) => (
                        <p key={line} className="text-xs text-muted-foreground">
                            {line}
                        </p>
                    ))}

                    {step.prompt.type === "select" ? (
                        <div className="space-y-2">
                            <Label className="text-xs">{step.prompt.message}</Label>
                            <div className="flex flex-wrap gap-2">
                                {step.prompt.options?.map((option) => (
                                    <Button key={option.id} size="sm" variant="outline" disabled={busy} onClick={() => void submit(option.id)}>
                                        {option.label}
                                    </Button>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <form
                            className="space-y-2"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void submit(answer);
                            }}
                        >
                            <Label className="text-xs" htmlFor="provider-auth-answer">
                                {step.prompt.message}
                            </Label>
                            <div className="flex gap-2">
                                <Input
                                    id="provider-auth-answer"
                                    autoFocus
                                    type={step.prompt.type === "secret" ? "password" : "text"}
                                    placeholder={step.prompt.placeholder}
                                    value={answer}
                                    onChange={(e) => setAnswer(e.target.value)}
                                    disabled={busy}
                                />
                                <Button type="submit" size="sm" disabled={busy || !answer.trim()}>
                                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Submit"}
                                </Button>
                            </div>
                        </form>
                    )}

                    <Button variant="ghost" size="sm" onClick={() => void cancel()}>
                        Cancel
                    </Button>
                </div>
            )}

            {providers === null ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading providers…
                </div>
            ) : (
                <div className="divide-y rounded-md border">
                    {providers.map((provider) => (
                        <div key={provider.id} className="flex items-center justify-between gap-3 p-2.5">
                            <div className="min-w-0">
                                <div className="text-sm truncate">
                                    {provider.name}
                                    {provider.configured && (
                                        <span className="ml-2 text-[11px] text-emerald-600 dark:text-emerald-400">signed in</span>
                                    )}
                                </div>
                                <div className="text-[11px] text-muted-foreground truncate">{provider.id}</div>
                            </div>
                            <div className="flex gap-2 shrink-0">
                                {provider.types.includes("oauth") && (
                                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void start(provider.id, "oauth")}>
                                        <LogIn className="h-3.5 w-3.5 mr-1" />
                                        Sign in
                                    </Button>
                                )}
                                {provider.types.includes("api_key") && (
                                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void start(provider.id, "api_key")}>
                                        <KeyRound className="h-3.5 w-3.5 mr-1" />
                                        API key
                                    </Button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
