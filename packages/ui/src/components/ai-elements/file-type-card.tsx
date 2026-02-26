"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { FileIcon, ImageIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export interface FileTypeCardProps {
  /** Full file path */
  path: string;
  /** Display name (defaults to basename of path) */
  fileName?: string;
  /** MIME type string */
  mimeType: string;
  /** Content to render inside the modal */
  children: React.ReactNode;
  className?: string;
}

export function FileTypeCard({
  path,
  fileName,
  mimeType,
  children,
  className,
}: FileTypeCardProps) {
  const [open, setOpen] = React.useState(false);

  const displayName =
    fileName ?? path.split(/[\\/]/).filter(Boolean).pop() ?? "file";

  const isImage = mimeType.startsWith("image/");
  const Icon = isImage ? ImageIcon : FileIcon;

  return (
    <>
      {/* ── Inline trigger card ───────────────────────────────────────────── */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "group flex w-full items-center gap-2.5 rounded-lg border border-border/80 bg-muted/30 px-3 py-2.5 text-left transition-colors hover:bg-muted/60 hover:border-border cursor-pointer",
          className,
        )}
      >
        {/* Icon */}
        <div className="flex size-8 sm:size-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground group-hover:text-foreground transition-colors">
          <Icon className="size-3.5 sm:size-4" />
        </div>

        {/* Name + path */}
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium text-foreground truncate block">
            {displayName}
          </span>
          <p className="mt-0.5 text-[11px] font-mono text-muted-foreground truncate">
            {path}
          </p>
        </div>

        {/* MIME badge — hidden on the smallest screens to preserve space */}
        <span className="hidden sm:inline-flex shrink-0 items-center rounded border border-border/60 bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
          {mimeType}
        </span>
      </button>

      {/* ── Modal ─────────────────────────────────────────────────────────── */}
      {/*
        Mobile (< 640px): bottom-sheet style — full width, anchored to bottom,
        max 90% of viewport height. Uses overrides on the base DialogContent
        positioning (top/left/translate) to pin it to the bottom edge.

        Desktop (≥ 640px): standard centred dialog at max-w-3xl.
      */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className={cn(
            "pp-file-card-dialog flex flex-col gap-0 p-0 overflow-hidden",
            // Mobile: bottom-sheet layout
            "max-w-full w-full rounded-t-xl rounded-b-none",
            "top-auto bottom-0 left-0 translate-x-0 translate-y-0",
            "max-h-[90dvh]",
            // Desktop: centred dialog
            "sm:max-w-3xl sm:w-auto sm:rounded-lg",
            "sm:top-[50%] sm:bottom-auto sm:left-[50%] sm:translate-x-[-50%] sm:translate-y-[-50%]",
            "sm:max-h-[85dvh]",
          )}
        >
          <DialogHeader className="pl-4 sm:pl-5 pr-12 pt-4 sm:pt-5 pb-3 border-b border-border/60 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              {/* Icon */}
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted text-muted-foreground">
                <Icon className="size-4" />
              </div>

              {/* Name + path */}
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-sm font-semibold truncate">
                  {displayName}
                </DialogTitle>
                <DialogDescription className="text-[11px] font-mono truncate">
                  {path}
                </DialogDescription>
              </div>

              {/* MIME badge — only shows when there's enough room (sm+) */}
              <span className="hidden sm:inline-flex shrink-0 items-center rounded border border-border/60 bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                {mimeType}
              </span>
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-auto p-0 min-h-0">
            {children}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
