import { SandboxManager } from "@/components/SandboxManager";
import type { SectionProps } from "./RunnerSettingsPanel";

export default function SandboxSettings({ runnerId }: SectionProps) {
    return (
        <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
                Sandbox controls filesystem, network, and socket access restrictions for agent sessions.
                Changes apply on next session start.
            </p>
            <SandboxManager runnerId={runnerId} bare />
        </div>
    );
}
