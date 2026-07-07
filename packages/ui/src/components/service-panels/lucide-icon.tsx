/**
 * Resolve a Lucide icon name string to a rendered icon.
 *
 * Dynamic panels declare their icon as a string (e.g. "activity", "cpu").
 * Every lucide icon name works: icons are lazy-loaded on demand via
 * lucide-react/dynamic, so the main bundle stays small (each icon is its
 * own tiny chunk, fetched only when first rendered). Legacy pre-rename
 * lucide names (e.g. "alert-circle") are remapped. Unknown names fall
 * back to Square.
 */
import type { ComponentType } from "react";
import { Square, type LucideProps } from "lucide-react";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";

/** Old lucide names → current canonical kebab names. */
const ALIASES: Record<string, string> = {
    "alert-circle": "circle-alert",
    "alert-triangle": "triangle-alert",
    "bar-chart": "chart-bar",
    "check-circle": "circle-check",
    "circle-help": "circle-question-mark",
    "file-json": "file-braces",
    "filter": "funnel",
    "fingerprint": "fingerprint-pattern",
    "help-circle": "circle-question-mark",
    "home": "house",
    "kanban-square": "square-kanban",
    "line-chart": "chart-line",
    "pie-chart": "chart-pie",
    "stop-circle": "circle-stop",
    "terminal-square": "square-terminal",
    "train": "tram-front",
    "unlock": "lock-open",
    "x-circle": "circle-x",
};

const VALID_NAMES = new Set<string>(iconNames);

/**
 * Normalize a kebab-case icon name to a valid lucide IconName,
 * or undefined if no such icon exists.
 */
export function resolveIconName(name: string): IconName | undefined {
    const canonical = ALIASES[name] ?? name;
    return VALID_NAMES.has(canonical) ? (canonical as IconName) : undefined;
}

/**
 * Render a Lucide icon by name string. Lazy-loads the icon on demand.
 * Unknown names render the `fallback` component (default Square).
 */
export function DynamicLucideIcon({
    name,
    fallback: Fallback = Square,
    className = "size-3.5",
    ...props
}: LucideProps & { name: string; fallback?: ComponentType<LucideProps> }) {
    const iconName = resolveIconName(name);
    if (!iconName) return <Fallback className={className} {...props} />;
    return (
        <DynamicIcon
            name={iconName}
            className={className}
            // invisible size-holding placeholder while the icon chunk loads
            fallback={() => <span className={className} />}
            {...props}
        />
    );
}
