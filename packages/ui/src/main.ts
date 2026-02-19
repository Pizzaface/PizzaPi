import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { App } from "./App.js";
import "./style.css";

// Apply dark mode before first render to avoid flash
const savedTheme = localStorage.getItem("theme");
if (savedTheme === "dark" || (!savedTheme && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
    document.documentElement.classList.add("dark");
}

const root = document.getElementById("app")!;
createRoot(root).render(createElement(App));
