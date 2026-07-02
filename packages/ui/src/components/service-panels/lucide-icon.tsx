/**
 * Resolve a Lucide icon name string to a React component.
 *
 * Dynamic panels declare their icon as a string (e.g. "activity", "cpu").
 * This maps those strings to the corresponding lucide-react component.
 *
 * ponytail: curated map instead of `import * as LucideIcons` — the namespace
 * import defeated tree-shaking and kept every lucide icon (~860KB minified)
 * in the main bundle, which the mobile WebView can't afford. Unknown names
 * fall back to Square; add entries here as services need them.
 */
import React from "react";
import {
    Activity,
    AlertTriangle,
    Bell,
    BookOpen,
    Box,
    Brain,
    Bug,
    Circle,
    Clock,
    Cloud,
    Cpu,
    Database,
    Diff,
    DollarSign,
    ExternalLink,
    File,
    FlaskConical,
    Folder,
    Github,
    Globe,
    HardDrive,
    Layers,
    List,
    MousePointerClick,
    Play,
    Radio,
    Rocket,
    Search,
    Server,
    Settings,
    Square,
    Tag,
    Terminal,
    TerminalSquare,
    Timer,
    Wifi,
    Wrench,
    Zap,
    type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
    "activity": Activity,
    "alert-triangle": AlertTriangle,
    "bell": Bell,
    "book-open": BookOpen,
    "box": Box,
    "brain": Brain,
    "bug": Bug,
    "circle": Circle,
    "clock": Clock,
    "cloud": Cloud,
    "cpu": Cpu,
    "database": Database,
    "diff": Diff,
    "dollar-sign": DollarSign,
    "external-link": ExternalLink,
    "file": File,
    "flask-conical": FlaskConical,
    "folder": Folder,
    "github": Github,
    "globe": Globe,
    "hard-drive": HardDrive,
    "layers": Layers,
    "list": List,
    "mouse-pointer-click": MousePointerClick,
    "play": Play,
    "radio": Radio,
    "rocket": Rocket,
    "search": Search,
    "server": Server,
    "settings": Settings,
    "square": Square,
    "tag": Tag,
    "terminal": Terminal,
    "terminal-square": TerminalSquare,
    "timer": Timer,
    "wifi": Wifi,
    "wrench": Wrench,
    "zap": Zap,
};

/**
 * Get a Lucide icon component by name. Returns Square if not found.
 */
export function getLucideIcon(name: string): LucideIcon {
    return ICONS[name] ?? Square;
}

/**
 * Render a Lucide icon by name string with standard panel icon sizing.
 */
export function DynamicLucideIcon({ name, className = "size-3.5" }: { name: string; className?: string }) {
    const Icon = getLucideIcon(name);
    return <Icon className={className} />;
}
