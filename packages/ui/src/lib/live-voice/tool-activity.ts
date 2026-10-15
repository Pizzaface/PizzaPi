import { baseToolName } from "@/components/session-viewer/utils";

const LABELS: Record<string, string> = {
    bash: "Running a command",
    shell: "Running a command",
    read: "Reading a file",
    read_file: "Reading a file",
    write: "Writing a file",
    write_file: "Writing a file",
    edit: "Editing a file",
    web_search: "Searching the web",
    web_fetch: "Reading a web page",
    search: "Searching files",
    grep: "Searching files",
    glob: "Searching files",
};

/** Brief, safe status for the Live overlay; never includes command arguments or tool output. */
export function describeActiveTools(toolNames: Iterable<string>): string | null {
    const labels = [...new Set(Array.from(toolNames, (name) => {
        const base = baseToolName(name);
        return LABELS[base] ?? (base && base !== "unknown" ? `Using ${base.replaceAll("_", " ")}` : "Working with a tool");
    }))];
    if (labels.length === 0) return null;
    const shown = labels.slice(0, 2).join(" · ");
    return labels.length > 2 ? `${shown} · +${labels.length - 2} more` : shown;
}
