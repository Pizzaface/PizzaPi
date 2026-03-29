import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input";
import { exportToMarkdown } from "@/lib/export-markdown";
import type { RelayMessage } from "./types";
import type { TriggerCounts } from "@/hooks/useTriggerCount";
import { formatFileSize } from "./formatters";
import {
  Check,
  Copy,
  Download,
  FolderTree,
  GitBranch,
  MoreHorizontal,
  PaperclipIcon,
  TerminalIcon,
  Zap,
} from "lucide-react";

// ── HeartbeatStaleBadge ──────────────────────────────────────────────────────

/**
 * Shows a small "⚠ stale" badge when no heartbeat has arrived in the last 35 s.
 * Checks every 5 s and clears automatically when the heartbeat resumes.
 */
export function HeartbeatStaleBadge({
  lastHeartbeatAt,
}: {
  lastHeartbeatAt: number | null | undefined;
}) {
  const [stale, setStale] = React.useState(false);

  React.useEffect(() => {
    if (!lastHeartbeatAt) {
      setStale(false);
      return;
    }
    const check = () => setStale(Date.now() - lastHeartbeatAt > 35_000);
    check();
    const timer = setInterval(check, 5_000);
    return () => clearInterval(timer);
  }, [lastHeartbeatAt]);

  if (!stale) return null;
  return (
    <span
      className="text-[0.65rem] text-amber-400/80"
      title="No heartbeat received in the last 35 seconds — CLI may be disconnected"
    >
      ⚠ stale
    </span>
  );
}

// ── ComposerAttachmentMeta ───────────────────────────────────────────────────

/**
 * Fetches and displays the size + media-type metadata for a single attachment.
 */
export function ComposerAttachmentMeta({
  file,
}: {
  file: { url?: string; mediaType?: string };
}) {
  const [sizeLabel, setSizeLabel] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    const url = file.url;
    if (!url) {
      setSizeLabel("");
      return;
    }
    fetch(url)
      .then((res) => res.blob())
      .then((blob) => {
        if (!cancelled) setSizeLabel(formatFileSize(blob.size));
      })
      .catch(() => {
        if (!cancelled) setSizeLabel("");
      });
    return () => {
      cancelled = true;
    };
  }, [file.url]);

  return (
    <div className="min-w-0 max-w-48 text-[10px] text-muted-foreground">
      <span className="truncate block">
        {sizeLabel || "size unknown"}
        {file.mediaType ? ` · ${file.mediaType}` : ""}
      </span>
    </div>
  );
}

// ── ComposerAttachmentButton ─────────────────────────────────────────────────

/** Paperclip button that opens the file-attachment dialog. */
export function ComposerAttachmentButton() {
  const attachments = usePromptInputAttachments();

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 shrink-0 text-muted-foreground"
      onClick={() => attachments.openFileDialog()}
      title="Add attachments"
      aria-label="Add attachments"
    >
      <PaperclipIcon className="size-4" />
    </Button>
  );
}

// ── ComposerAttachments ──────────────────────────────────────────────────────

/** Inline attachment strip shown above the prompt textarea when files are attached. */
export function ComposerAttachments() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;
  return (
    <div className="px-2 pb-2">
      <Attachments variant="inline" className="w-full gap-1.5">
        {attachments.files.map((file) => (
          <Attachment
            key={file.id}
            data={file}
            onRemove={() => attachments.remove(file.id)}
          >
            <AttachmentPreview />
            <div className="min-w-0 max-w-56">
              <span className="block truncate text-xs">{file.filename || "Attachment"}</span>
              <ComposerAttachmentMeta file={file} />
            </div>
            <AttachmentRemove />
          </Attachment>
        ))}
      </Attachments>
    </div>
  );
}

// ── HeaderOverflowMenu ───────────────────────────────────────────────────────

export interface HeaderOverflowMenuProps {
  showTerminalButton?: boolean;
  onToggleTerminal?: () => void;
  isTerminalOpen?: boolean;
  showFileExplorerButton?: boolean;
  onToggleFileExplorer?: () => void;
  isFileExplorerOpen?: boolean;
  showGitButton?: boolean;
  onToggleGit?: () => void;
  isGitOpen?: boolean;
  showTriggersButton?: boolean;
  onToggleTriggers?: () => void;
  isTriggersOpen?: boolean;
  triggerCount?: TriggerCounts;
  onDuplicateSession?: () => void;
  messages: RelayMessage[];
  sessionId: string | null;
}

/**
 * Mobile "⋯" overflow menu that surfaces panel toggles and export actions
 * for viewports too narrow to show the full header toolbar.
 */
export function HeaderOverflowMenu({
  showTerminalButton,
  onToggleTerminal,
  isTerminalOpen,
  showFileExplorerButton,
  onToggleFileExplorer,
  isFileExplorerOpen,
  showGitButton,
  onToggleGit,
  isGitOpen,
  showTriggersButton,
  onToggleTriggers,
  isTriggersOpen,
  triggerCount,
  onDuplicateSession,
  messages,
  sessionId,
}: HeaderOverflowMenuProps) {
  const [copyState, setCopyState] = React.useState<"idle" | "copied">("idle");
  const timerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  React.useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopyExport = async () => {
    const md = exportToMarkdown(messages);
    try {
      await navigator.clipboard.writeText(md);
      setCopyState("copied");
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      /* silent */
    }
  };

  const handleDownloadExport = () => {
    const md = exportToMarkdown(messages);
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `session-${sessionId ?? "export"}.md`;
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="h-7 w-7 md:hidden"
          size="icon"
          type="button"
          variant="outline"
          aria-label="More options"
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {showTerminalButton && onToggleTerminal && (
          <DropdownMenuItem onSelect={onToggleTerminal}>
            <TerminalIcon className="size-3.5 mr-2 shrink-0" />
            Terminal
            {isTerminalOpen && <Check className="size-3 ml-auto text-primary" />}
          </DropdownMenuItem>
        )}
        {showFileExplorerButton && onToggleFileExplorer && (
          <DropdownMenuItem onSelect={onToggleFileExplorer}>
            <FolderTree className="size-3.5 mr-2 shrink-0" />
            Files
            {isFileExplorerOpen && <Check className="size-3 ml-auto text-primary" />}
          </DropdownMenuItem>
        )}
        {showGitButton && onToggleGit && (
          <DropdownMenuItem onSelect={onToggleGit}>
            <GitBranch className="size-3.5 mr-2 shrink-0" />
            Git
            {isGitOpen && <Check className="size-3 ml-auto text-primary" />}
          </DropdownMenuItem>
        )}
        {showTriggersButton && onToggleTriggers && (
          <DropdownMenuItem onSelect={onToggleTriggers}>
            <Zap className="size-3.5 mr-2 shrink-0" />
            Triggers
            {(triggerCount?.pending ?? 0) > 0 && (
              <span className="ml-1 flex items-center justify-center min-w-[16px] h-4 rounded-full bg-amber-500 text-[10px] font-bold text-black px-1 leading-none">
                {triggerCount!.pending > 9 ? "9+" : triggerCount!.pending}
              </span>
            )}
            {(triggerCount?.subscriptions ?? 0) > 0 && (
              <span className="ml-1 flex items-center justify-center min-w-[16px] h-4 rounded-full bg-blue-500 text-[10px] font-bold text-white px-1 leading-none">
                {triggerCount!.subscriptions > 9 ? "9+" : triggerCount!.subscriptions}
              </span>
            )}
            {isTriggersOpen && <Check className="size-3 ml-auto text-primary" />}
          </DropdownMenuItem>
        )}
        {(showTerminalButton ||
          showFileExplorerButton ||
          showGitButton ||
          showTriggersButton) && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={handleCopyExport}>
          <Copy className="size-3.5 mr-2 shrink-0" />
          {copyState === "copied" ? "Copied!" : "Copy as Markdown"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleDownloadExport}>
          <Download className="size-3.5 mr-2 shrink-0" />
          Download Markdown
        </DropdownMenuItem>
        {onDuplicateSession && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onDuplicateSession}>
              <Copy className="size-3.5 mr-2 shrink-0" />
              Duplicate Session
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
