import { useState } from "react";
import { Monitor, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type { SectionProps } from "./RunnerSettingsPanel";

/** Extract nested value with fallback. */
function dig(obj: Record<string, any>, path: string[], fallback: any): any {
    let cur: any = obj;
    for (const key of path) {
        if (cur == null || typeof cur !== "object") return fallback;
        cur = cur[key];
    }
    return cur ?? fallback;
}

export default function TuiPrefsSettings({ tuiSettings, onSave, saving }: SectionProps) {
    const [tuiMode, setTuiMode] = useState<string>(tuiSettings.tuiMode === "regular" ? "regular" : "fullscreen");
    const [theme, setTheme] = useState<string>(typeof tuiSettings.theme === "string" && tuiSettings.theme ? tuiSettings.theme : "system");
    const [quietStartup, setQuietStartup] = useState<string>(
        tuiSettings.quietStartup === "header" ? "header" : tuiSettings.quietStartup === false ? "full" : "quiet",
    );
    const [clearOnShrink, setClearOnShrink] = useState<boolean>(
        dig(tuiSettings, ["terminal", "clearOnShrink"], false) === true,
    );
    const [steeringMode, setSteeringMode] = useState<string>(tuiSettings.steeringMode === "all" ? "all" : "one-at-a-time");
    const [transport, setTransport] = useState<string>(
        ["sse", "websocket", "websocket-cached"].includes(tuiSettings.transport) ? tuiSettings.transport : "auto",
    );
    const [doubleEscapeAction, setDoubleEscapeAction] = useState<string>(
        ["fork", "none"].includes(tuiSettings.doubleEscapeAction) ? tuiSettings.doubleEscapeAction : "tree",
    );
    const [enableSkillCommands, setEnableSkillCommands] = useState<boolean>(
        dig(tuiSettings, ["enableSkillCommands"], true) !== false,
    );

    async function handleSave() {
        await onSave("tuiPreferences", {
            tuiMode,
            theme,
            quietStartup: quietStartup === "header" ? "header" : quietStartup === "quiet",
            terminal: { ...tuiSettings.terminal, clearOnShrink },
            steeringMode,
            transport,
            doubleEscapeAction,
            enableSkillCommands,
        });
    }

    return (
        <div className="flex flex-col gap-6">
            {/* Header */}
            <div className="flex items-center gap-2">
                <Monitor className="h-5 w-5 text-muted-foreground" />
                <h3 className="text-sm font-medium">TUI Preferences</h3>
            </div>

            {[
                { id: "tui-mode", label: "Terminal Mode", description: "Fullscreen is Pi 1.0's default. Regular keeps the terminal's normal scrollback.", value: tuiMode, onChange: setTuiMode, options: [["fullscreen", "Fullscreen"], ["regular", "Regular"]] },
                { id: "tui-theme", label: "Terminal Theme", description: "System uses the terminal's palette. This does not change the web UI theme.", value: theme, onChange: setTheme, options: [["system", "System"], ["dark", "Dark"], ["light", "Light"], ...(typeof tuiSettings.theme === "string" && tuiSettings.theme && !["system", "dark", "light"].includes(tuiSettings.theme) ? [[tuiSettings.theme, tuiSettings.theme]] : [])] },
                { id: "tui-startup", label: "Startup Display", description: "PizzaPi stays quiet by default. Header shows the version and key hints without the resource list.", value: quietStartup, onChange: setQuietStartup, options: [["quiet", "Quiet"], ["header", "Header only"], ["full", "Full"]] },
            ].map(({ id, label, description, value, onChange, options }) => (
                <div key={id} className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
                    <Label htmlFor={id} className="text-sm font-medium">{label}</Label>
                    <p className="text-xs text-muted-foreground">{description}</p>
                    <Select value={value} onValueChange={onChange}>
                        <SelectTrigger id={id} className="w-[180px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {options.map(([key, name]) => <SelectItem key={key} value={key}>{name}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </div>
            ))}

            {/* Clear on Shrink */}
            <div className="flex items-center justify-between rounded-md border border-border bg-card p-4">
                <div className="flex flex-col gap-1">
                    <Label htmlFor="tui-clear-on-shrink" className="text-sm font-medium">
                        Clear on Shrink
                    </Label>
                    <p className="text-xs text-muted-foreground">
                        Clear the terminal buffer when the window shrinks to avoid rendering artifacts.
                    </p>
                </div>
                <Switch
                    id="tui-clear-on-shrink"
                    checked={clearOnShrink}
                    onCheckedChange={setClearOnShrink}
                />
            </div>

            {/* Steering Mode */}
            <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
                <Label htmlFor="tui-steering-mode" className="text-sm font-medium">
                    Steering Mode
                </Label>
                <p className="text-xs text-muted-foreground">
                    Deliver queued steering messages one at a time or all together.
                </p>
                <Select value={steeringMode} onValueChange={setSteeringMode}>
                    <SelectTrigger id="tui-steering-mode" className="w-[180px]">
                        <SelectValue placeholder="Select mode" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="one-at-a-time">One at a time</SelectItem>
                        <SelectItem value="all">All</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {/* Transport */}
            <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
                <Label htmlFor="tui-transport" className="text-sm font-medium">
                    Provider Transport
                </Label>
                <p className="text-xs text-muted-foreground">
                    Preferred AI provider connection. Auto selects a supported transport; this does not configure MCP servers.
                </p>
                <Select value={transport} onValueChange={setTransport}>
                    <SelectTrigger id="tui-transport" className="w-[180px]">
                        <SelectValue placeholder="Select transport" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="auto">Auto</SelectItem>
                        <SelectItem value="sse">SSE</SelectItem>
                        <SelectItem value="websocket">WebSocket</SelectItem>
                        <SelectItem value="websocket-cached">WebSocket (cached)</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {/* Double Escape Action */}
            <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
                <Label htmlFor="tui-double-escape" className="text-sm font-medium">
                    Double-Escape Action
                </Label>
                <p className="text-xs text-muted-foreground">
                    With an empty editor, open the session tree, fork the session, or disable the shortcut.
                </p>
                <Select value={doubleEscapeAction} onValueChange={setDoubleEscapeAction}>
                    <SelectTrigger id="tui-double-escape" className="w-[180px]">
                        <SelectValue placeholder="Select action" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="tree">Session tree</SelectItem>
                        <SelectItem value="fork">Fork</SelectItem>
                        <SelectItem value="none">None</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {/* Enable Skill Commands */}
            <div className="flex items-center justify-between rounded-md border border-border bg-card p-4">
                <div className="flex flex-col gap-1">
                    <Label htmlFor="tui-skill-commands" className="text-sm font-medium">
                        Enable Skill Commands
                    </Label>
                    <p className="text-xs text-muted-foreground">
                        Allow /skill slash commands in the terminal for quick access to predefined agent skills.
                    </p>
                </div>
                <Switch
                    id="tui-skill-commands"
                    checked={enableSkillCommands}
                    onCheckedChange={setEnableSkillCommands}
                />
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between pt-2">
                <p className="text-xs text-muted-foreground italic">
                    TUI preferences affect the terminal interface on the runner. Changes apply on next session start.
                </p>
                <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
                    <Save className="h-3.5 w-3.5" />
                    {saving ? "Saving…" : "Save"}
                </Button>
            </div>
        </div>
    );
}
