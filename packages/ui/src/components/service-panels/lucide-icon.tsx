/**
 * Resolve a Lucide icon name string to a React component.
 *
 * Dynamic panels declare their icon as a string (e.g. "activity", "cpu").
 * This utility maps those strings to the corresponding lucide-react component.
 *
 * Uses a lazy lookup into the lucide-react exports. Unknown names fall back
 * to the Square icon.
 */
import React from "react";
import * as LucideIcons from "lucide-react";

/**
 * Convert a kebab-case icon name to PascalCase component name.
 * e.g. "arrow-right" → "ArrowRight", "cpu" → "Cpu", "activity" → "Activity"
 */
function toPascalCase(name: string): string {
    return name
        .split("-")
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");
}

/**
 * Get a Lucide icon component by name. Returns Square if not found.
 */
export function getLucideIcon(name: string): LucideIcons.LucideIcon {
    const pascalName = toPascalCase(name);
    const icon = (LucideIcons as Record<string, unknown>)[pascalName];
    if (icon && typeof icon === "function") {
        return icon as LucideIcons.LucideIcon;
    }
    return LucideIcons.Square;
}

/**
 * Render a Lucide icon by name string with standard panel icon sizing.
 */
export function DynamicLucideIcon({ name, className = "size-3.5" }: { name: string; className?: string }) {
    const Icon = getLucideIcon(name);
    return <Icon className={className} />;
}
