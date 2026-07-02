import * as React from "react";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Card, CardContent, CardTitle, CardHeader, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, KeyRound, RefreshCw, ShieldCheck, Smartphone } from "lucide-react";

interface MobileLinkStatus {
    id: string;
    status: "pending" | "scanned" | "approved" | "expired";
    relayUrl: string;
    verificationToken?: string;
    deviceName?: string;
    scannedUrl?: string;
    expiresAt: string;
}

function resolveRelayUrl(): string {
    const configured = import.meta.env?.VITE_RELAY_URL?.trim();
    if (configured) {
        const normalized = configured.replace(/\/+$/, "");
        if (/^https?:\/\//i.test(normalized)) return normalized;
        if (/^wss?:\/\//i.test(normalized)) {
            return normalized.replace(/^wss/i, "https").replace(/^ws/i, "http");
        }
    }
    return window.location.origin.replace(/\/+$/, "");
}

type State =
    | { kind: "loading" }
    | { kind: "ready"; claim: MobileLinkStatus; qrDataUrl: string }
    | { kind: "error"; message: string };

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, {
        ...init,
        credentials: "same-origin",
        headers: {
            ...(init?.body ? { "Content-Type": "application/json" } : {}),
            ...init?.headers,
        },
    });
    const data = await res.json().catch(() => null) as T | { error?: string } | null;
    const message = data && typeof data === "object" && "error" in data ? data.error : undefined;
    if (!res.ok) throw new Error(message || `Request failed (${res.status})`);
    return data as T;
}

export function MobileSetupQR() {
    const relayUrl = resolveRelayUrl();
    const [state, setState] = useState<State>({ kind: "loading" });

    const createClaim = React.useCallback(async () => {
        setState({ kind: "loading" });
        try {
            const data = await apiFetch<MobileLinkStatus>("/api/mobile-link", {
                method: "POST",
                body: JSON.stringify({ relayUrl }),
            });
            if (!data?.id) throw new Error("Could not create mobile link QR");
            const linkUrl = `${relayUrl}/mobile-link?id=${encodeURIComponent(data.id)}`;
            const qrDataUrl = await QRCode.toDataURL(linkUrl, {
                errorCorrectionLevel: "H",
                margin: 1,
                width: 280,
                color: { dark: "#1c1917", light: "#ffffff" },
            });
            setState({ kind: "ready", claim: data, qrDataUrl });
        } catch (err) {
            setState({ kind: "error", message: err instanceof Error ? err.message : "Could not create mobile link QR" });
        }
    }, [relayUrl]);

    useEffect(() => {
        void createClaim();
    }, [createClaim]);

    useEffect(() => {
        if (state.kind !== "ready" || state.claim.status === "approved" || state.claim.status === "expired") return;
        const timer = window.setInterval(async () => {
            const data = await apiFetch<MobileLinkStatus>(`/api/mobile-link/${state.claim.id}`);
            if (data) setState((s) => s.kind === "ready" ? { ...s, claim: data } : s);
        }, 1500);
        return () => window.clearInterval(timer);
    }, [state]);

    const approve = async () => {
        if (state.kind !== "ready") return;
        try {
            const data = await apiFetch<MobileLinkStatus>(`/api/mobile-link/${state.claim.id}/approve`, { method: "POST" });
            setState({ ...state, claim: data });
        } catch (err) {
            setState({ kind: "error", message: err instanceof Error ? err.message : "Could not approve mobile device" });
        }
    };

    const ready = state.kind === "ready" ? state : null;
    const claim = ready?.claim ?? null;

    return (
        <Card className="w-full">
            <CardHeader>
                <div className="flex items-center gap-2">
                    <KeyRound className="h-5 w-5 text-muted-foreground" />
                    <CardTitle>Link Mobile App</CardTitle>
                </div>
                <CardDescription>
                    Scan this QR in the Android app. Approve the matching code here before the app can continue.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <div className="flex flex-col items-center gap-3">
                    {state.kind === "error" ? (
                        <div className="text-sm text-destructive text-center">{state.message}</div>
                    ) : ready ? (
                        <img src={ready.qrDataUrl} alt="QR code to link the PizzaPi mobile app" className="rounded-md border-2 border-border" />
                    ) : (
                        <div className="h-[280px] w-[280px] rounded-md border flex items-center justify-center">
                            <Smartphone className="h-8 w-8 animate-pulse text-muted-foreground" />
                        </div>
                    )}

                    {claim?.status === "pending" && (
                        <div className="text-xs text-muted-foreground text-center">
                            Waiting for the mobile app to scan. Expires {new Date(claim.expiresAt).toLocaleTimeString()}.
                        </div>
                    )}

                    {claim?.status === "scanned" && (
                        <div className="w-full rounded-md border bg-muted/30 p-3 text-sm space-y-3">
                            <div className="flex items-center gap-2 font-medium">
                                <ShieldCheck className="h-4 w-4" />
                                Approve new mobile device?
                            </div>
                            <div className="text-muted-foreground">Confirm this code matches the Android app:</div>
                            <div className="rounded bg-background px-3 py-2 text-center font-mono text-2xl tracking-widest">
                                {claim.verificationToken}
                            </div>
                            {claim.deviceName && <div className="text-xs text-muted-foreground">Device: {claim.deviceName}</div>}
                            <Button onClick={approve} className="w-full">Approve mobile app</Button>
                        </div>
                    )}

                    {claim?.status === "approved" && (
                        <div className="flex items-center gap-2 text-sm text-green-600">
                            <CheckCircle2 className="h-4 w-4" /> Mobile app approved. It can continue to sign in.
                        </div>
                    )}

                    {claim?.status === "expired" && (
                        <div className="text-sm text-destructive">This QR expired. Generate a new one.</div>
                    )}

                    <Button variant="outline" size="sm" onClick={createClaim} disabled={state.kind === "loading"} className="gap-2">
                        <RefreshCw className="h-4 w-4" />New QR
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
