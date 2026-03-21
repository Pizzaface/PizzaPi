import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Keyboard } from "lucide-react";

interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/i.test(navigator.platform);
}

export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
  const isMac = isMacPlatform();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-4 w-4" />
            Keyboard Shortcuts
          </DialogTitle>
          <DialogDescription>
            Available shortcuts for the PizzaPi web UI.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2.5 text-sm py-1">
          {(
            [
              { key: isMac ? "⌘K" : "Ctrl+K", action: "Focus prompt" },
              { key: "Ctrl+`", action: "Toggle terminal" },
              { key: isMac ? "⌘⇧E" : "Ctrl+Shift+E", action: "Toggle file explorer" },
              { key: isMac ? "⌘." : "Ctrl+.", action: "Abort active agent" },
              { key: "?", action: "Show this dialog" },
            ] as { key: string; action: string }[]
          ).map(({ key, action }) => (
            <div key={key} className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{action}</span>
              <kbd className="inline-flex items-center rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground whitespace-nowrap">
                {key}
              </kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
