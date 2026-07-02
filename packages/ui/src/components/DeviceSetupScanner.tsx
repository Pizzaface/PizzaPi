import * as React from "react";
// ponytail: type-only — the 330KB html5-qrcode lib is dynamically imported on scan start
import type { Html5Qrcode } from "html5-qrcode";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Smartphone, Camera, AlertCircle, CheckCircle2 } from "lucide-react";

interface ScannerState {
    kind: "idle" | "requesting" | "scanning" | "approving" | "approved" | "error";
    message?: string;
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

async function approveClaim(token: string): Promise<{ ok: boolean; error?: string }> {
    try {
        const { error } = await authClient.$fetch(`/api/setup-claim/${token}/approve`, {
            method: "POST",
        });
        if (error) {
            return { ok: false, error: (error as any)?.message ?? "Approval failed" };
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Network error" };
    }
}

export function DeviceSetupScanner({ onClose }: { onClose?: () => void }) {
    const [state, setState] = React.useState<ScannerState>({ kind: "idle" });
    const [manualToken, setManualToken] = React.useState("");
    const [cameraError, setCameraError] = React.useState<string | null>(null);
    const scannerRef = React.useRef<Html5Qrcode | null>(null);
    const readerId = React.useId() + "-qr-reader";

    React.useEffect(() => {
        return () => {
            if (scannerRef.current) {
                scannerRef.current
                    .stop()
                    .catch(() => {
                        // Ignore stop errors during unmount.
                    })
                    .finally(() => {
                        scannerRef.current?.clear();
                    });
            }
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
                cameras[0].id,
                { fps: 10, qrbox: { width: 250, height: 250 } },
                async (decodedText) => {
                    const token = extractToken(decodedText);
                    if (!token) return;
                    try {
                        await scanner.stop();
                    } catch {
                        // Ignore.
                    }
                    await handleApprove(token);
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
    }, [handleApprove]);

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
                {state.kind === "approved" ? (
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

                        <div
                            id={readerId}
                            className="mx-auto aspect-square w-full max-w-[300px] overflow-hidden rounded-md border bg-black"
                            hidden={state.kind !== "scanning"}
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
