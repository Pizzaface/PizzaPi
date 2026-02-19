import { defineConfig, type Plugin } from "vite";

const API_PORT = process.env.PORT ?? "3000";

// Vite plugin to disable Lit's DEV_MODE in pre-bundled deps.
// Lit's dev build throws on class field shadowing, aborting the first render.
// The pi-web-ui library ships compiled JS with native class fields + legacy
// decorators, which inherently causes shadowing. In production mode the check
// is absent and the component works fine (setAgent calls requestUpdate).
function litProdMode(): Plugin {
    return {
        name: "lit-prod-mode",
        transform(code, id) {
            if (id.includes("node_modules")) {
                return code
                    .replace(/\bvar DEV_MODE\s*=\s*true\b/g, "var DEV_MODE = false")
                    .replace(/\bvar DEV_MODE2\s*=\s*true\b/g, "var DEV_MODE2 = false");
            }
        },
    };
}

export default defineConfig({
    plugins: [litProdMode()],
    server: {
        port: 5173,
        proxy: {
            "/api": `http://localhost:${API_PORT}`,
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
