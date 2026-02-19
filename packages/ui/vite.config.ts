import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const API_PORT = process.env.PORT ?? "3000";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    server: {
        port: 5173,
        proxy: {
            "/api": `http://localhost:${API_PORT}`,
            "/ws": {
                target: `http://localhost:${API_PORT}`,
                ws: true,
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
