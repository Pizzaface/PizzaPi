import * as React from "react";
// ponytail: type-only — the 330KB html5-qrcode lib is dynamically imported on scan start
import type { Html5Qrcode } from "html5-qrcode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Smartphone, Camera, AlertCircle, CheckCircle2 } from "lucide-react";

interface ScannerState {
    kind: "idle" | "requesting" | "scanning" | "confirm" | "approving" | "approved" | "error";
    message?: string;
    /** Decoded token awaiting explicit user confirmation (kind === "confirm"). */
    token?: string;
    /** Operator-facing name of the device/runner asking for approval, if the claim has one. */
    label?: string;
}

function extractToken(decodedText: string): string | null {
    try {
        const url = new URL(decodedText);
        const token = url.searchParams.get("t");
        if (token) return token;
    } catch {
        // Not a URL — treat the raw text as the token if it looks like one.
    }
    const raw = decodedText.trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) return raw;
    return null;
}

/**
 * Best-effort label lookup for the confirmation screen; never blocks approval.
 * Hits the non-consuming /api/setup-claim-info/:token route — the plain
 * /api/setup-claim/:token route is a one-shot redeem for the CLI and must
 * never be called from here (doing so would silently burn the approved key
 * out from under the CLI's poll).
 *
 * Note the separate prefix rather than a nested /info path: older relays parse
 * the poll route's token with split("/")[0], so a nested path would reach
 * their consuming handler with a valid token. This UI ships as its own image
 * and will meet older servers; there it simply 404s and the label is omitted.
 */
async function fetchClaimLabel(token: string): Promise<string | undefined> {
    try {
        const res = await fetch(`/api/setup-claim-info/${token}`);
        if (!res.ok) return undefined;
        const data = (await res.json()) as { label?: string };
        return typeof data.label === "string" && data.label ? data.label : undefined;
    } catch {
        return undefined;
    }
}

/**
 * ponytail: plain fetch, not authClient.$fetch — the auth client prefixes its
 * baseURL (`<origin>/api/auth`), which turned this into a 404 at
 * /api/auth/api/setup-claim/:token/approve. The route accepts the browser
 * session cookie, and the mobile fetch patch adds x-api-key for the bundled app.
 */
async function approveClaim(token: string): Promise<{ ok: boolean; error?: string }> {
    try {
        const res = await fetch(`/api/setup-claim/${token}/approve`, {
            method: "POST",
            credentials: "include",
        });
        if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { error?: string } | null;
            return { ok: false, error: body?.error ?? `Approval failed (HTTP ${res.status})` };
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Network error" };
    }
}

/**
 * Stop + clear without ever throwing.
 *
 * ponytail: html5-qrcode throws a bare *string* synchronously from stop()/clear()
 * when the scanner isn't in the state it expects ("Cannot stop, scanner is not
 * running or paused."). A .catch() on the returned promise never sees that, so
 * it escaped the unmount cleanup and tripped the app's error boundary whenever
 * the panel closed before start() finished.
 */
async function teardownScanner(scanner: Html5Qrcode): Promise<void> {
    try {
        await scanner.stop();
    } catch {
        // Not scanning (or already stopped) — nothing to stop.
    }
    try {
        scanner.clear();
    } catch {
        // Nothing rendered to clear.
    }
}

export function DeviceSetupScanner({ initialToken, onClose }: { initialToken?: string; onClose?: () => void }) {
    const [state, setState] = React.useState<ScannerState>({ kind: "idle" });
    // A deep-link (?t=…) token is pre-filled into the manual-approve field; the
    // user still has to click Approve, so nothing is approved without a click.
    const [manualToken, setManualToken] = React.useState(initialToken ?? "");
    const [cameraError, setCameraError] = React.useState<string | null>(null);
    const scannerRef = React.useRef<Html5Qrcode | null>(null);
    const readerId = React.useId() + "-qr-reader";

    React.useEffect(() => {
        return () => {
            const scanner = scannerRef.current;
            if (scanner) void teardownScanner(scanner);
        };
    }, []);

    const handleApprove = React.useCallback(async (token: string) => {
        setState({ kind: "approving" });
        const result = await approveClaim(token);
        if (result.ok) {
            setState({ kind: "approved" });
        } else {
            setState({ kind: "error", message: result.error });
        }
    }, []);

    // Show the confirm screen immediately, then fill in the label once it
    // arrives — never block or fail the confirmation on the label lookup.
    const requestConfirmation = React.useCallback((token: string) => {
        setState({ kind: "confirm", token });
        void fetchClaimLabel(token).then((label) => {
            if (!label) return;
            setState((prev) => (prev.kind === "confirm" && prev.token === token ? { ...prev, label } : prev));
        });
    }, []);

    const startScanning = React.useCallback(async () => {
        setCameraError(null);
        setState({ kind: "requesting" });

        let Html5Qrcode: typeof import("html5-qrcode").Html5Qrcode;
        try {
            ({ Html5Qrcode } = await import("html5-qrcode"));
        } catch {
            setCameraError("Failed to load the QR scanner.");
            setState({ kind: "idle" });
            return;
        }

        let cameras;
        try {
            // This call triggers the browser's camera permission prompt.
            cameras = await Html5Qrcode.getCameras();
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            setCameraError("Camera access was denied or is unavailable.");
            setState({ kind: "idle" });
            return;
        }

        if (!cameras || cameras.length === 0) {
            setCameraError("No camera found on this device.");
            setState({ kind: "idle" });
            return;
        }

        if (!document.getElementById(readerId)) {
            setCameraError("Scanner preview is not ready.");
            setState({ kind: "idle" });
            return;
        }

        const scanner = new Html5Qrcode(readerId);
        scannerRef.current = scanner;

        try {
            await scanner.start(
                // ponytail: a facingMode constraint, not cameras[0].id — the first
                // enumerated device is the selfie camera on Android, so scanning
                // opened the wrong lens. Bare string, not { ideal } (html5-qrcode
                // rejects that) and not { exact } (hard-fails on a front-camera-only
                // laptop); getUserMedia treats a bare string as "ideal". getCameras()
                // above stays: it drives the permission prompt and no-camera message.
                { facingMode: "environment" },
                { fps: 10, qrbox: { width: 250, height: 250 } },
                async (decodedText) => {
                    const token = extractToken(decodedText);
                    if (!token) return;
                    try {
                        await scanner.stop();
                    } catch {
                        // Ignore.
                    }
                    // Require an explicit confirmation click before approving — a QR
                    // that merely lands in frame must not auto-approve a device.
                    requestConfirmation(token);
                },
                () => {
                    // Scan failures are frequent and noisy; ignore them.
                },
            );
            setState({ kind: "scanning" });
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            setCameraError(`Could not start camera: ${detail}`);
            setState({ kind: "idle" });
        }
    }, [requestConfirmation]);

    const handleManualSubmit = React.useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault();
            const token = manualToken.trim();
            if (!token) return;
            await handleApprove(token);
        },
        [handleApprove, manualToken],
    );

    return (
        <Card className="w-full">
            <CardHeader>
                <div className="flex items-center gap-2">
                    <Smartphone className="h-5 w-5 text-muted-foreground" />
                    <CardTitle>Set Up a New Device</CardTitle>
                </div>
                <CardDescription>
                    Scan the QR code shown by{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">pizzapi setup --scan</code>{" "}
                    to approve the device.
                </CardDescription>
            </CardHeader>

            <CardContent className="flex flex-col gap-4">
                {state.kind === "confirm" && state.token ? (
                    <div className="flex flex-col items-center gap-3 py-4">
                        <AlertCircle className="h-10 w-10 text-amber-600" />
                        <p className="text-sm font-medium">Approve this device?</p>
                        <p className="text-center text-xs text-muted-foreground">
                            Only approve if you started this setup. Approving grants the device an API key for your account.
                        </p>
                        {state.label && (
                            <p className="text-center text-sm font-semibold">{state.label}</p>
                        )}
                        <code className="max-w-full break-all rounded bg-muted px-2 py-1 text-xs font-mono">{state.token}</code>
                        <div className="mt-2 flex gap-2">
                            <Button variant="outline" onClick={() => setState({ kind: "idle" })}>
                                Cancel
                            </Button>
                            <Button onClick={() => handleApprove(state.token!)}>
                                Approve this device
                            </Button>
                        </div>
                    </div>
                ) : state.kind === "approved" ? (
                    <div className="flex flex-col items-center gap-3 py-6">
                        <CheckCircle2 className="h-12 w-12 text-green-500" />
                        <p className="text-sm font-medium">Device approved successfully.</p>
                        <p className="text-xs text-muted-foreground">The CLI has received its API key and is ready to use.</p>
                        {onClose && (
                            <Button onClick={onClose} className="mt-2">
                                Done
                            </Button>
                        )}
                    </div>
                ) : (
                    <>
                        {state.kind === "idle" && (
                            <div className="flex flex-col items-center gap-3 py-4">
                                <Camera className="h-10 w-10 text-muted-foreground" />
                                <p className="text-sm text-muted-foreground">
                                    Camera access is required to scan the QR code. We only use the camera for this scan.
                                </p>
                                <Button onClick={startScanning} className="mt-2">
                                    <Camera className="h-4 w-4 mr-2" />
                                    Allow Camera & Scan
                                </Button>
                            </div>
                        )}

                        {(state.kind === "requesting" || state.kind === "approving") && (
                            <div className="flex flex-col items-center gap-2 py-6">
                                <Spinner className="h-8 w-8" />
                                <p className="text-sm text-muted-foreground">
                                    {state.kind === "requesting" ? "Waiting for camera permission…" : "Approving device…"}
                                </p>
                            </div>
                        )}

                        {state.kind === "scanning" && (
                            <p className="text-center text-xs text-muted-foreground">Point your camera at the QR code on the new device.</p>
                        )}

                        {/*
                          * Visible from "requesting" on, not just "scanning":
                          * html5-qrcode measures this element inside start(), and a
                          * hidden (display:none) container measures 0×0 — the camera
                          * opens but the preview renders as a black square. The two
                          * awaits in startScanning (dynamic import, getCameras) give
                          * React time to flush this before start() runs.
                          */}
                        <div
                            id={readerId}
                            className="mx-auto aspect-square w-full max-w-[300px] overflow-hidden rounded-md border bg-black"
                            hidden={state.kind !== "scanning" && state.kind !== "requesting"}
                        />

                        {state.kind === "error" && (
                            <div className="flex items-start gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3">
                                <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
                                <div className="flex flex-col gap-1">
                                    <p className="text-sm font-medium">Could not approve device</p>
                                    <p className="text-xs text-muted-foreground">{state.message}</p>
                                </div>
                            </div>
                        )}

                        {cameraError && (
                            <div className="flex items-start gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
                                <AlertCircle className="h-5 w-5 shrink-0 text-amber-600" />
                                <div className="flex flex-col gap-1">
                                    <p className="text-sm font-medium">Camera issue</p>
                                    <p className="text-xs text-muted-foreground">{cameraError}</p>
                                </div>
                            </div>
                        )}

                        <form onSubmit={handleManualSubmit} className="flex flex-col gap-2 pt-2">
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="setup-token" className="text-xs">Can’t scan? Paste the setup token instead</Label>
                                <div className="flex gap-2">
                                    <Input
                                        id="setup-token"
                                        placeholder="Setup token"
                                        value={manualToken}
                                        onChange={(e) => setManualToken(e.target.value)}
                                        className="font-mono text-xs"
                                    />
                                    <Button type="submit" disabled={!manualToken.trim() || state.kind === "approving"}>
                                        {state.kind === "approving" ? (
                                            <Spinner className="h-4 w-4" />
                                        ) : (
                                            "Approve"
                                        )}
                                    </Button>
                                </div>
                            </div>
                        </form>
                    </>
                )}
            </CardContent>
        </Card>
    );
}
