/**
 * Shared handle for the native `@capacitor/app` plugin's `appStateChange`
 * event. Registered exactly once here (by name, via `registerPlugin`, same
 * as the other native bridges in this app) so two independent call sites
 * (mobile-ota.ts's deferred-reload-on-background, App.tsx's resume-triggered
 * reconnect) don't each call `registerPlugin("App", ...)` themselves —
 * Capacitor warns and ignores the second registration, which silently
 * drops whichever behavior registered last.
 */
import { registerPlugin } from "@capacitor/core";

export interface AppStateChangeEvent {
    /** True when foregrounded; false when backgrounded. */
    isActive: boolean;
}

/** Minimal shape of the bits of @capacitor/app we call. */
export interface CapacitorAppPlugin {
    addListener(
        eventName: "appStateChange",
        listenerFunc: (state: AppStateChangeEvent) => void,
    ): Promise<{ remove: () => Promise<void> }>;
}

// Web no-op so the proxy never rejects on the PWA build (calls are guarded to
// native anyway). On native, registerPlugin routes to the "App" plugin that
// `cap sync` installs — @capacitor/app is already pulled in transitively
// (via @aparajita/capacitor-secure-storage), so there's no need to add a
// direct npm dependency or import its JS wrapper.
class CapacitorAppWeb implements CapacitorAppPlugin {
    async addListener(): Promise<{ remove: () => Promise<void> }> {
        return { remove: async () => {} };
    }
}

export const CapacitorApp = registerPlugin<CapacitorAppPlugin>("App", {
    web: async () => new CapacitorAppWeb(),
});
