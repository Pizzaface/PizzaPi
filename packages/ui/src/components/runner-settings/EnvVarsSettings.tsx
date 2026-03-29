import type { SectionProps } from "./RunnerSettingsPanel";

export default function EnvVarsSettings({ config, tuiSettings, onSave, saving }: SectionProps) {
    return (
        <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
            <p className="text-sm text-muted-foreground">EnvVars settings — coming soon</p>
        </div>
    );
}
