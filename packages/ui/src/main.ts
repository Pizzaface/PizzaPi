import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ui/error-boundary.js";
import { AttentionProvider } from "./attention/index.js";
import { installMobileFetchPatch } from "./lib/mobile-fetch.js";
import { initMobileRuntime } from "./lib/mobile-runtime.js";
import "./style.css";

// Apply dark mode before first render to avoid flash
const savedTheme = localStorage.getItem("theme");
if (savedTheme === "dark" || (!savedTheme && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
    document.documentElement.classList.add("dark");
}

// When bundled inside the Capacitor app, load any stored API key from native
// secure storage (or capture a freshly redeemed key passed via the URL
// fragment) before installing the fetch patch / rendering. No-op on web.
// Wrapped in an async boot function (not top-level await) so the build target
// stays compatible with older browsers.
async function boot(): Promise<void> {
    await initMobileRuntime();

    // When bundled inside the Capacitor app, relative fetch URLs must be rewritten
    // to the configured relay server and authenticated with the injected API key.
    installMobileFetchPatch();

    const root = document.getElementById("app")!;
    // Wrap App in a root-level ErrorBoundary so crashes inside App itself are caught.
    // Note: an ErrorBoundary CANNOT catch errors thrown by the component that renders it,
    // so the boundary must be *outside* App — hence it lives here in main.ts rather than
    // inside App's own render method.
    createRoot(root).render(
        createElement(ErrorBoundary, { level: "root", children:
            createElement(AttentionProvider, null, createElement(App)),
        }),
    );
}

// A silent boot failure used to leave a black screen (dark theme bg + no
// content). Surface it visibly so it can be troubleshot from the device.
void boot().catch((err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    // eslint-disable-next-line no-console
    console.error("PizzaPi boot failed:", err);
    const root = document.getElementById("app");
    if (root) {
        const pre = document.createElement("pre");
        pre.style.cssText =
            "color:#fca5a5;background:#1c1917;margin:0;padding:16px;min-height:100vh;" +
            "white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,monospace";
        pre.textContent = `PizzaPi failed to start:\n\n${detail}`;
        root.replaceChildren(pre);
    }
});
