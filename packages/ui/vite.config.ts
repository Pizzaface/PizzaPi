import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";
import fs from "fs";

const API_PORT = process.env.PORT ?? "3001";

// Derive extra allowed hosts from the PIZZAPI_EXTRA_ORIGINS env var so the
// Vite dev server accepts requests from those origins without hardcoding them.
// e.g. PIZZAPI_EXTRA_ORIGINS=https://myhost.ts.net,http://myhost.ts.net:5173
const extraAllowedHosts: string[] = process.env.PIZZAPI_EXTRA_ORIGINS
    ? process.env.PIZZAPI_EXTRA_ORIGINS.split(",")
          .map((o) => { try { return new URL(o.trim()).hostname; } catch { return ""; } })
          .filter(Boolean)
    : [];

// Load Tailscale TLS certs for HTTPS dev server if they exist.
// Generate them once with: sudo tailscale cert --cert-file certs/ts.crt --key-file certs/ts.key <your-tailscale-hostname>
const CERT_FILE = path.resolve(__dirname, "../../certs/ts.crt");
const KEY_FILE = path.resolve(__dirname, "../../certs/ts.key");
const tlsConfig =
    fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)
        ? { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) }
        : undefined;

export default defineConfig({
    plugins: [
        react(),
        tailwindcss(),
        VitePWA({
            registerType: "autoUpdate",
            includeAssets: ["favicon.ico", "pizza.svg", "apple-touch-icon-180x180.png"],
            manifest: {
                name: "PizzaPi",
                short_name: "PizzaPi",
                description: "PizzaPi — AI coding agent interface",
                theme_color: "#1c1917",
                background_color: "#1c1917",
                display: "standalone",
                orientation: "any",
                scope: "/",
                start_url: "/",
                icons: [
                    {
                        src: "pwa-64x64.png",
                        sizes: "64x64",
                        type: "image/png",
                    },
                    {
                        src: "pwa-192x192.png",
                        sizes: "192x192",
                        type: "image/png",
                    },
                    {
                        src: "pwa-512x512.png",
                        sizes: "512x512",
                        type: "image/png",
                    },
                    {
                        src: "maskable-icon-512x512.png",
                        sizes: "512x512",
                        type: "image/png",
                        purpose: "maskable",
                    },
                ],
            },
            devOptions: {
            enabled: true,
        },
        workbox: {
                // Raise the per-file precache limit to cover the main app bundle.
                maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, // 3 MiB
                // Precache HTML/CSS/core assets; skip giant lazy syntax-highlighter chunks.
                globPatterns: ["**/*.{css,html,ico,png,svg,woff,woff2}"],
                // Inject the push notification handler into the generated service worker.
                importScripts: ["sw-push.js"],
                navigateFallback: "/index.html",
                runtimeCaching: [
                    {
                        // Cache JS chunks (including lazy shiki/mermaid language chunks)
                        // after first load, so they're available instantly on revisits.
                        urlPattern: /\.js$/,
                        handler: "StaleWhileRevalidate",
                        options: {
                            cacheName: "js-chunks",
                            expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 },
                        },
                    },
                    {
                        // API calls always go to the network — never cache
                        urlPattern: /^\/api\//,
                        handler: "NetworkOnly",
                    },
                    {
                        // WebSocket upgrade requests — ignored by workbox automatically,
                        // but being explicit keeps the config readable
                        urlPattern: /^\/ws\//,
                        handler: "NetworkOnly",
                    },
                ],
            },
        }),
    ],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    server: {
        port: 5173,
        allowedHosts: extraAllowedHosts.length ? extraAllowedHosts : undefined,
        https: tlsConfig,
        proxy: {
            "/api": `http://localhost:${API_PORT}`,
            "/socket.io": {
                target: `http://localhost:${API_PORT}`,
                ws: true,
                configure: (proxy) => {
                    proxy.on("error", (err) => {
                        const code = (err as NodeJS.ErrnoException).code;
                        if (code === "ECONNRESET" || err.message.includes("socket has been ended") || err.message.includes("socket hang up")) return;
                        console.error("[socket.io proxy]", err);
                    });
                },
            },
        },
    },
    build: {
        outDir: "dist",
        rollupOptions: {
            external: [
                "child_process",
                "fs/promises",
                "fs",
                "path",
                "util",
                "stream",
                "os",
                "net",
                "tls",
                "dns",
                "url",
                "buffer",
                "node:stream",
                "node:buffer",
                "node:console",
                "node:assert",
                "@pizzapi/tools",
                /@smithy\/.*$/,
            ],
        },
    },
    optimizeDeps: {
        exclude: ["@pizzapi/tools"],
        esbuildOptions: {
            target: "es2021",
            define: {
                global: "globalThis",
            },
        },
    },
});
