import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ui/error-boundary.js";
import "./style.css";

// Apply dark mode before first render to avoid flash
const savedTheme = localStorage.getItem("theme");
if (savedTheme === "dark" || (!savedTheme && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
    document.documentElement.classList.add("dark");
}

const root = document.getElementById("app")!;
// Wrap App in a root-level ErrorBoundary so crashes inside App itself are caught.
// Note: an ErrorBoundary CANNOT catch errors thrown by the component that renders it,
// so the boundary must be *outside* App — hence it lives here in main.ts rather than
// inside App's own render method.
createRoot(root).render(
    createElement(ErrorBoundary, { level: "root", children: createElement(App) }),
);
