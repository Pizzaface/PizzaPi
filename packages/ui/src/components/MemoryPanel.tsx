import { useState, useEffect, useCallback } from "react";
import { useServiceChannel } from "@/hooks/useServiceChannel";
import { reportError } from "@/lib/frontend-log";
import { RefreshCw, Save, FileText } from "lucide-react";

interface MemoryFile {
    file: string;
    bytes: number;
    lines: number;
}

interface MemoryPanelProps {
    sessionId: string;
    runnerId?: string;
}

export function MemoryPanel({ sessionId }: MemoryPanelProps) {
    const [files, setFiles] = useState<MemoryFile[]>([]);
    const [dir, setDir] = useState<string>("");
    const [active, setActive] = useState<string | null>(null);
    const [content, setContent] = useState("");
    const [dirty, setDirty] = useState(false);
    const [loaded, setLoaded] = useState(false);

    const { send, available } = useServiceChannel<unknown, unknown>("memory", {
        onMessage: (type, payload) => {
            const p = payload as Record<string, unknown>;
            if (type === "memory_list_result") {
                setFiles((p.files as MemoryFile[]) ?? []);
                setDir((p.dir as string) ?? "");
                setLoaded(true);
            } else if (type === "memory_read_result") {
                setActive((p.file as string) ?? null);
                setContent((p.content as string) ?? "");
                setDirty(false);
            } else if (type === "memory_write_result") {
                setDirty(false);
                send("memory_list", { sessionId });
            } else if (type === "memory_error") {
                reportError("memory", (p.error as string) || "Memory operation failed");
            }
        },
    });

    const refresh = useCallback(() => send("memory_list", { sessionId }), [send, sessionId]);

    useEffect(() => {
        if (!available) {
            setFiles([]);
            setLoaded(false);
            return;
        }
        refresh();
    }, [available, refresh]);

    if (!available) return null;

    const openFile = (file: string) => {
        if (dirty && !confirm("Discard unsaved changes?")) return;
        send("memory_read", { sessionId, file });
    };
    const save = () => {
        if (active) send("memory_write", { sessionId, file: active, content });
    };

    return (
        <div className="flex h-full overflow-hidden">
            {/* File list */}
            <div className="w-48 shrink-0 border-r border-border flex flex-col overflow-hidden">
                <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-muted/20 shrink-0">
                    <span className="text-xs text-muted-foreground">
                        {files.length} file{files.length === 1 ? "" : "s"}
                    </span>
                    <div className="flex-1" />
                    <button
                        type="button"
                        onClick={refresh}
                        className="p-1 text-muted-foreground hover:text-foreground rounded"
                        title="Refresh"
                    >
                        <RefreshCw size={12} />
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto">
                    {files.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-xs text-muted-foreground px-3 text-center">
                            {loaded ? "No memory yet. The agent saves findings here as it works." : "Loading…"}
                        </div>
                    ) : (
                        files.map((f) => (
                            <button
                                key={f.file}
                                type="button"
                                onClick={() => openFile(f.file)}
                                className={`w-full flex items-center gap-1.5 px-3 py-1.5 text-left text-xs hover:bg-accent/30 ${
                                    active === f.file ? "bg-accent/50" : ""
                                }`}
                                title={`${f.lines} lines · ${f.bytes} B`}
                            >
                                <FileText size={12} className="shrink-0 text-muted-foreground" />
                                <span className="truncate font-mono">{f.file}</span>
                            </button>
                        ))
                    )}
                </div>
            </div>

            {/* Editor */}
            <div className="flex-1 flex flex-col overflow-hidden">
                {active ? (
                    <>
                        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-muted/20 shrink-0">
                            <span className="text-xs font-mono truncate" title={dir ? `${dir}/${active}` : active}>
                                {active}
                                {dirty && <span className="ml-1 text-primary/80">•</span>}
                            </span>
                            <div className="flex-1" />
                            <button
                                type="button"
                                onClick={save}
                                disabled={!dirty}
                                className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground disabled:opacity-40"
                                title="Save"
                            >
                                <Save size={12} /> Save
                            </button>
                        </div>
                        <textarea
                            value={content}
                            onChange={(e) => {
                                setContent(e.target.value);
                                setDirty(true);
                            }}
                            spellCheck={false}
                            className="flex-1 w-full resize-none bg-background text-xs font-mono p-3 outline-none"
                        />
                    </>
                ) : (
                    <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                        Select a memory file to view or edit
                    </div>
                )}
            </div>
        </div>
    );
}
