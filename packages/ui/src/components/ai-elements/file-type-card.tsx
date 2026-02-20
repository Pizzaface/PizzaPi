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
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "group flex w-full items-center gap-3 rounded-lg border border-border/80 bg-muted/30 px-3 py-2.5 text-left transition-colors hover:bg-muted/60 hover:border-border cursor-pointer",
          className,
        )}
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground group-hover:text-foreground transition-colors">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium text-foreground truncate block">
            {displayName}
          </span>
          <p className="mt-0.5 text-[11px] font-mono text-muted-foreground truncate">
            {path}
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center rounded border border-border/60 bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
          {mimeType}
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
          <DialogHeader className="px-5 pt-5 pb-3 border-b border-border/60 shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted text-muted-foreground">
                <Icon className="size-4" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-sm font-semibold truncate">
                  {displayName}
                </DialogTitle>
                <DialogDescription className="text-[11px] font-mono truncate">
                  {path}
                </DialogDescription>
              </div>
              <span className="ml-auto inline-flex shrink-0 items-center rounded border border-border/60 bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                {mimeType}
              </span>
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-auto p-0">
            {children}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
