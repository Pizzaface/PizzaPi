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
    DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
    isPushSupported,
    isPushSubscribed,
    subscribeToPush,
    unsubscribeFromPush,
    getNotificationPermission,
} from "@/lib/push";

function usePushState() {
    const [subscribed, setSubscribed] = React.useState(false);
    const [loading, setLoading] = React.useState(true);
    const [supported, setSupported] = React.useState(false);

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
        });
    }, []);

    const toggle = React.useCallback(async () => {
        if (loading) return;
        setLoading(true);
        try {
            if (subscribed) {
                const ok = await unsubscribeFromPush();
                if (ok) setSubscribed(false);
            } else {
                const sub = await subscribeToPush();
                setSubscribed(sub !== null);
            }
        } catch (err) {
            console.error("[push] toggle failed:", err);
        } finally {
            setLoading(false);
        }
    }, [subscribed, loading]);

    const permissionDenied = getNotificationPermission() === "denied";

    return { subscribed, loading, supported, permissionDenied, toggle };
}

export function NotificationToggle() {
    const { subscribed, loading, supported, permissionDenied, toggle } = usePushState();

    if (!supported) return null;

    const label = loading
        ? "Loading…"
        : permissionDenied
          ? "Notifications blocked by browser"
          : subscribed
            ? "Notifications enabled (click to disable)"
            : "Enable notifications";

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
                        {subscribed ? (
                            <Bell className="h-4 w-4 text-foreground" />
                        ) : (
                            <BellOff className="h-4 w-4 text-muted-foreground opacity-50" />
                        )}
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
    const { subscribed, loading, supported, permissionDenied, toggle } = usePushState();

    if (!supported) return null;

    return (
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
    );
}
