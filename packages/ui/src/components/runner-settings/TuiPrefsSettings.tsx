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
    const [clearOnShrink, setClearOnShrink] = useState<boolean>(
        dig(tuiSettings, ["terminal", "clearOnShrink"], true) !== false,
    );
    const [steeringMode, setSteeringMode] = useState<string>(
        dig(tuiSettings, ["steeringMode"], "auto"),
    );
    const [transport, setTransport] = useState<string>(
        dig(tuiSettings, ["transport"], "stdio"),
    );
    const [doubleEscapeAction, setDoubleEscapeAction] = useState<string>(
        dig(tuiSettings, ["doubleEscapeAction"], "abort"),
    );
    const [enableSkillCommands, setEnableSkillCommands] = useState<boolean>(
        dig(tuiSettings, ["enableSkillCommands"], true) !== false,
    );

    async function handleSave() {
        await onSave("tuiPreferences", {
            terminal: { clearOnShrink },
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
                    How follow-up messages are handled. Auto sends them automatically, manual requires
                    confirmation, and off disables follow-ups entirely.
                </p>
                <Select value={steeringMode} onValueChange={setSteeringMode}>
                    <SelectTrigger id="tui-steering-mode" className="w-[180px]">
                        <SelectValue placeholder="Select mode" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="auto">Auto</SelectItem>
                        <SelectItem value="manual">Manual</SelectItem>
                        <SelectItem value="off">Off</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {/* Transport */}
            <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
                <Label htmlFor="tui-transport" className="text-sm font-medium">
                    MCP Transport
                </Label>
                <p className="text-xs text-muted-foreground">
                    Transport protocol used for MCP server communication. stdio uses standard I/O pipes,
                    http uses HTTP requests.
                </p>
                <Select value={transport} onValueChange={setTransport}>
                    <SelectTrigger id="tui-transport" className="w-[180px]">
                        <SelectValue placeholder="Select transport" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="stdio">stdio</SelectItem>
                        <SelectItem value="http">http</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {/* Double Escape Action */}
            <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
                <Label htmlFor="tui-double-escape" className="text-sm font-medium">
                    Double-Escape Action
                </Label>
                <p className="text-xs text-muted-foreground">
                    What happens when you press Escape twice quickly. Abort cancels the current
                    operation, menu opens the command menu, and none disables the shortcut.
                </p>
                <Select value={doubleEscapeAction} onValueChange={setDoubleEscapeAction}>
                    <SelectTrigger id="tui-double-escape" className="w-[180px]">
                        <SelectValue placeholder="Select action" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="abort">Abort</SelectItem>
                        <SelectItem value="menu">Menu</SelectItem>
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
