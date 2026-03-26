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
import { createLogger } from "@pizzapi/tools";

const log = createLogger("push");

function usePushState() {
    const [subscribed, setSubscribed] = React.useState(false);
    const [loading, setLoading] = React.useState(true);
    const [supported, setSupported] = React.useState(false);
    const [suppressChild, setSuppressChild] = React.useState(false);
    const [suppressChildLoading, setSuppressChildLoading] = React.useState(false);

    React.useEffect(() => {
        const sup = isPushSupported();
        setSupported(sup);
        if (!sup) {
            setLoading(false);
            return;
        }
        isPushSubscribed().then((s) => {
            setSubscribed(s);
            setLoading(false);
            if (s) {
                getSuppressChildNotifications().then((val) => {
                    if (val !== null) setSuppressChild(val);
                });
            }
        });
    }, []);

    const toggle = React.useCallback(async () => {
        if (loading) return;
        setLoading(true);
        try {
            if (subscribed) {
                const ok = await unsubscribeFromPush();
                if (ok) {
                    setSubscribed(false);
                    setSuppressChild(false);
                }
            } else {
                const sub = await subscribeToPush();
                setSubscribed(sub !== null);
                if (sub !== null) {
                    getSuppressChildNotifications().then((val) => {
                        if (val !== null) setSuppressChild(val);
                    });
                }
            }
        } catch (err) {
            log.error("toggle failed:", err);
        } finally {
            setLoading(false);
        }
    }, [subscribed, loading]);

    const toggleSuppressChild = React.useCallback(async () => {
        if (suppressChildLoading || !subscribed) return;
        setSuppressChildLoading(true);
        try {
            const next = !suppressChild;
            const ok = await setSuppressChildNotifications(next);
            if (ok) setSuppressChild(next);
        } catch (err) {
            log.error("suppressChild toggle failed:", err);
        } finally {
            setSuppressChildLoading(false);
        }
    }, [suppressChild, suppressChildLoading, subscribed]);

    const permissionDenied = getNotificationPermission() === "denied";

    return { subscribed, loading, supported, permissionDenied, toggle, suppressChild, suppressChildLoading, toggleSuppressChild };
}

export function NotificationToggle() {
    const { subscribed, loading, supported, permissionDenied, toggle, suppressChild, suppressChildLoading, toggleSuppressChild } = usePushState();

    if (!supported) return null;

    const label = loading
        ? "Loading…"
        : permissionDenied
          ? "Notifications blocked by browser"
          : subscribed
            ? "Notifications enabled"
            : "Enable notifications";

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
                <TooltipContent>
                    <p>{label}</p>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}

/**
 * Notification toggle rendered as a DropdownMenuItem (for mobile menus).
 */
export function MobileNotificationMenuItem() {
    const { subscribed, loading, supported, permissionDenied, toggle, suppressChild, suppressChildLoading, toggleSuppressChild } = usePushState();

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
                {subscribed ? "Disable notifications" : "Enable notifications"}
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
