import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
    appId: "dev.pizzapi.app",
    appName: "PizzaPi",
    webDir: "mobile",
    server: {
        androidScheme: "https",
    },
    plugins: {
        SplashScreen: {
            launchAutoHide: true,
            backgroundColor: "#1c1917",
        },
        CapacitorHttp: {
            enabled: true,
        },
        // Self-hosted OTA web-bundle updates. We run in MANUAL mode (see
        // packages/ui/src/lib/mobile-ota.ts) because the relay server URL is
        // chosen at runtime, so Capgo's build-time `updateUrl` isn't used.
        // `autoUpdate: false` stops the plugin from polling a config URL on its
        // own — our code drives download/set/reload against the paired server.
        CapacitorUpdater: {
            autoUpdate: false,
        },
    },
};

export default config;
