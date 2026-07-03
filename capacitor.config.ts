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
    },
};

export default config;
