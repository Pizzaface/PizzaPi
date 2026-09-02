import * as React from "react";
import { Bell, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
    isPushSupported,
    isPushSubscribed,
    subscribeToPush,
    unsubscribeFromPush,
    getNotificationPermission,
    getSuppressChildNotifications,
    setSuppressChildNotifications,
} from "@/lib/push";
import {
    isNativePushAvailable,
    isNativePushDisabled,
    setNativePushDisabled,
    hasNativePushPermission,
    requestNativePushPermission,
    startNtfyPush,
    stopNtfyPush,
    getNativeSuppressChildNotifications,
    setNativeSuppressChildNotifications,
} from "@/lib/ntfy-push";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("push");

export interface PushDependencies {
    isPushSupported: typeof isPushSupported;
    isPushSubscribed: typeof isPushSubscribed;
    subscribeToPush: typeof subscribeToPush;
    unsubscribeFromPush: typeof unsubscribeFromPush;
    getNotificationPermission: typeof getNotificationPermission;
    getSuppressChildNotifications: typeof getSuppressChildNotifications;
    setSuppressChildNotifications: typeof setSuppressChildNotifications;
    isNativePushAvailable: typeof isNativePushAvailable;
    isNativePushDisabled: typeof isNativePushDisabled;
    setNativePushDisabled: typeof setNativePushDisabled;
    hasNativePushPermission: typeof hasNativePushPermission;
    requestNativePushPermission: typeof requestNativePushPermission;
    startNtfyPush: typeof startNtfyPush;
    stopNtfyPush: typeof stopNtfyPush;
    getNativeSuppressChildNotifications: typeof getNativeSuppressChildNotifications;
    setNativeSuppressChildNotifications: typeof setNativeSuppressChildNotifications;
}

const defaultPushDependencies: PushDependencies = {
    isPushSupported,
    isPushSubscribed,
    subscribeToPush,
    unsubscribeFromPush,
    getNotificationPermission,
    getSuppressChildNotifications,
    setSuppressChildNotifications,
    isNativePushAvailable,
    isNativePushDisabled,
    setNativePushDisabled,
    hasNativePushPermission,
    requestNativePushPermission,
    startNtfyPush,
    stopNtfyPush,
    getNativeSuppressChildNotifications,
    setNativeSuppressChildNotifications,
};

export function usePushState(dependencies: PushDependencies = defaultPushDependencies) {
    const {
        isPushSupported,
        isPushSubscribed,
        subscribeToPush,
        unsubscribeFromPush,
        getNotificationPermission,
        getSuppressChildNotifications,
        setSuppressChildNotifications,
        isNativePushAvailable,
        isNativePushDisabled,
        setNativePushDisabled,
        hasNativePushPermission,
        requestNativePushPermission,
        startNtfyPush,
        stopNtfyPush,
        getNativeSuppressChildNotifications,
        setNativeSuppressChildNotifications,
    } = dependencies;
    // Android native app: no service worker / Web Push in the WebView — use the
    // ntfy foreground-service path gated on the OS notification permission.
    const native = isNativePushAvailable();
    const [subscribed, setSubscribed] = React.useState(false);
    const [loading, setLoading] = React.useState(true);
    const [supported, setSupported] = React.useState(false);
    const [nativeDenied, setNativeDenied] = React.useState(false);
    // True when the last registration attempt hit the server's "ntfy not
    // configured" (503) response — a distinct, user-visible state from a
    // generic failure or from being subscribed.
    const [nativeUnconfigured, setNativeUnconfigured] = React.useState(false);
    const [suppressChild, setSuppressChild] = React.useState(false);
    const [suppressChildLoading, setSuppressChildLoading] = React.useState(false);

    // Initial load + sync when another instance changes state
    const refreshState = React.useCallback(() => {
        if (native) {
            hasNativePushPermission().then(async (granted) => {
                if (!granted || isNativePushDisabled()) {
                    setSubscribed(false);
                    setNativeUnconfigured(false);
                    setSuppressChild(false);
                    setLoading(false);
                    return;
                }
                // No persistence layer for "did the last registration succeed" —
                // registration is idempotent and cheap, so verify it live on
                // every refresh instead of trusting a stale flag.
                const result = await startNtfyPush();
                setSubscribed(result.ok);
                setNativeUnconfigured(!result.ok && result.reason === "unconfigured");
                // startNtfyPush caches the server value in localStorage.
                if (result.ok) setSuppressChild(getNativeSuppressChildNotifications());
                setLoading(false);
            });
            return;
        }
        if (!isPushSupported()) return;
        isPushSubscribed().then((s) => {
            setSubscribed(s);
            setLoading(false);
            if (s) {
                getSuppressChildNotifications().then((val) => {
                    if (val !== null) setSuppressChild(val);
                });
            } else {
                setSuppressChild(false);
            }
        });
    }, [native]);

    React.useEffect(() => {
        const sup = native || isPushSupported();
        setSupported(sup);
        if (!sup) {
            setLoading(false);
            return;
        }
        refreshState();
        // Listen for state changes from other usePushState instances
        const onSync = () => refreshState();
        window.addEventListener("pp-push-state-changed", onSync);
        return () => window.removeEventListener("pp-push-state-changed", onSync);
    }, [refreshState, native]);

    const toggle = React.useCallback(async () => {
        if (loading) return;
        setLoading(true);
        try {
            if (native) {
                if (subscribed) {
                    setNativePushDisabled(true);
                    await stopNtfyPush();
                    setSubscribed(false);
                    setNativeUnconfigured(false);
                } else {
                    const granted = await requestNativePushPermission();
                    setNativeDenied(!granted);
                    if (granted) {
                        setNativePushDisabled(false);
                        const result = await startNtfyPush();
                        setSubscribed(result.ok);
                        setNativeUnconfigured(!result.ok && result.reason === "unconfigured");
                    }
                }
                window.dispatchEvent(new CustomEvent("pp-push-state-changed"));
            } else if (subscribed) {
                const ok = await unsubscribeFromPush();
                if (ok) {
                    setSubscribed(false);
                    setSuppressChild(false);
                    window.dispatchEvent(new CustomEvent("pp-push-state-changed"));
                }
            } else {
                const sub = await subscribeToPush();
                setSubscribed(sub !== null);
                if (sub !== null) {
                    getSuppressChildNotifications().then((val) => {
                        if (val !== null) setSuppressChild(val);
                    });
                }
                window.dispatchEvent(new CustomEvent("pp-push-state-changed"));
            }
        } catch (err) {
            log.error("toggle failed:", err);
        } finally {
            setLoading(false);
        }
    }, [subscribed, loading, native]);

    const toggleSuppressChild = React.useCallback(async () => {
        if (suppressChildLoading || !subscribed) return;
        setSuppressChildLoading(true);
        try {
            const next = !suppressChild;
            // Route to the native or web API depending on platform.
            const ok = native
                ? await setNativeSuppressChildNotifications(next)
                : await setSuppressChildNotifications(next);
            if (ok) {
                setSuppressChild(next);
                window.dispatchEvent(new CustomEvent("pp-push-state-changed"));
            }
        } catch (err) {
            log.error("suppressChild toggle failed:", err);
        } finally {
            setSuppressChildLoading(false);
        }
    }, [suppressChild, suppressChildLoading, subscribed, native]);

    // On native, "denied" only after an explicit request came back denied —
    // Android can't distinguish never-asked from denied, and the fix lives in
    // system settings, not another prompt.
    const permissionDenied = native ? nativeDenied : getNotificationPermission() === "denied";

    return { subscribed, loading, supported, native, permissionDenied, nativeUnconfigured, toggle, suppressChild, suppressChildLoading, toggleSuppressChild };
}

export function NotificationToggle({ dependencies }: { dependencies?: PushDependencies } = {}) {
    const { subscribed, loading, supported, native, permissionDenied, nativeUnconfigured, toggle, suppressChild, suppressChildLoading, toggleSuppressChild } = usePushState(dependencies);

    if (!supported) return null;

    const label = loading
        ? "Loading…"
        : permissionDenied
          ? native
              ? "Notifications blocked — enable in system settings"
              : "Notifications blocked by browser"
          : nativeUnconfigured
            ? "Push not configured on this server"
            : subscribed
              ? "Notifications enabled"
              : "Enable notifications";

    // When the browser/OS has denied permission, the button is disabled — so
    // tell the user how to re-enable it rather than leaving a dead end.
    const blockedHint = permissionDenied
        ? native
            ? "Turn on notifications for PizzaPi in your system settings, then reload."
            : "Allow notifications for this site in your browser's address-bar/site settings, then reload."
        : null;

    const bellIcon = subscribed ? (
        <Bell className="h-4 w-4 text-foreground" />
    ) : (
        <BellOff className="h-4 w-4 text-muted-foreground opacity-50" />
    );

    // When subscribed, show a dropdown with notification settings.
    // When not subscribed (or blocked), keep the simple one-click subscribe button.
    if (subscribed) {
        return (
            <DropdownMenu>
                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    disabled={loading || permissionDenied}
                                    className="h-8 w-8"
                                    aria-label={label}
                                >
                                    {bellIcon}
                                </Button>
                            </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent>
                            <p>{label}</p>
                        </TooltipContent>
                    </Tooltip>
                </TooltipProvider>
                <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuLabel>Notification settings</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {/*
                     * Suppress child session notifications.
                     * Available for both Web Push and native (ntfy) registrations.
                     * The Switch is a pure visual indicator — clicking anywhere on the
                     * row (text or switch) fires onSelect exactly once via the MenuItem.
                     * We do NOT attach onCheckedChange to Switch to avoid a double-toggle
                     * where both onSelect and onCheckedChange fire on a single click.
                     */}
                    <DropdownMenuItem
                        className="flex items-center justify-between gap-2 cursor-default"
                        onSelect={(e) => {
                            e.preventDefault();
                            toggleSuppressChild();
                        }}
                        disabled={suppressChildLoading}
                    >
                        <span className="text-sm leading-snug">
                            Suppress child session notifications
                        </span>
                        <Switch
                            checked={suppressChild}
                            disabled={suppressChildLoading}
                        />
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={(e) => {
                            e.preventDefault();
                            toggle();
                        }}
                        disabled={loading}
                    >
                        <BellOff className="h-4 w-4 mr-2" />
                        Disable notifications
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    }

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={toggle}
                        disabled={loading || permissionDenied}
                        className="h-8 w-8"
                        aria-label={label}
                    >
                        {bellIcon}
                    </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-[16rem]">
                    <p>{label}</p>
                    {blockedHint && <p className="mt-1 text-muted-foreground">{blockedHint}</p>}
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}

/**
 * Notification toggle rendered as a DropdownMenuItem (for mobile menus).
 */
export function MobileNotificationMenuItem() {
    const { subscribed, loading, supported, permissionDenied, nativeUnconfigured, toggle, suppressChild, suppressChildLoading, toggleSuppressChild } = usePushState();

    if (!supported) return null;

    return (
        <>
            <DropdownMenuItem
                className="md:hidden"
                disabled={loading || permissionDenied}
                onSelect={(e) => {
                    e.preventDefault();
                    toggle();
                }}
            >
                {subscribed ? (
                    <Bell className="h-4 w-4" />
                ) : (
                    <BellOff className="h-4 w-4" />
                )}
                {subscribed
                    ? "Disable notifications"
                    : nativeUnconfigured
                      ? "Push not configured on this server"
                      : "Enable notifications"}
            </DropdownMenuItem>
            {subscribed && (
                <DropdownMenuItem
                    className="md:hidden flex items-center justify-between gap-2 cursor-default"
                    disabled={suppressChildLoading}
                    onSelect={(e) => {
                        e.preventDefault();
                        toggleSuppressChild();
                    }}
                >
                    <span className="text-sm">Suppress child session notifications</span>
                    <Switch
                        checked={suppressChild}
                        disabled={suppressChildLoading}
                    />
                </DropdownMenuItem>
            )}
        </>
    );
}
