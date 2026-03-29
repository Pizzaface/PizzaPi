import type { SectionProps } from "./RunnerSettingsPanel";

export default function SandboxSettings({ config, tuiSettings, onSave, saving }: SectionProps) {
    return (
        <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
            <p className="text-sm text-muted-foreground">Sandbox settings — coming soon</p>
        </div>
    );
}
