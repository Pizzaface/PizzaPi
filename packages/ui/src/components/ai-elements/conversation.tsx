"use client";

import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { RelayMessage } from "@/components/session-viewer/types";
import { exportToMarkdown } from "@/lib/export-markdown";
import { cn } from "@/lib/utils";
import { ArrowDownIcon, CheckIcon, ClipboardIcon, DownloadIcon, ShareIcon } from "lucide-react";
import { useCallback, useEffect, useState, useRef } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="instant"
    resize="instant"
    role="log"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<
  typeof StickToBottom.Content
>;

export const ConversationContent = ({
  className,
  ...props
}: ConversationContentProps) => (
  <StickToBottom.Content
    className={cn("flex flex-col gap-8 p-4", className)}
    {...props}
  />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

/**
 * Hook to access the StickToBottom scroll container ref from within a
 * <Conversation> tree. Used by the pagination sentinel to set up an
 * IntersectionObserver rooted at the actual scrollable element.
 */
export function useConversationScrollRef() {
  const { scrollRef } = useStickToBottomContext();
  return scrollRef;
}

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted",
          className
        )}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};

// --- Conversation Export (dropdown: copy to clipboard / download as file) ---

export type ConversationExportProps = Omit<
  ComponentProps<typeof Button>,
  "onClick"
> & {
  messages: RelayMessage[];
  filename?: string;
  /** Duration in ms to show the success checkmark (default 2000) */
  feedbackMs?: number;
};

export const ConversationExport = ({
  messages,
  filename = "conversation.md",
  feedbackMs = 2000,
  className,
  ...props
}: ConversationExportProps) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => clearTimeout(timerRef.current);
  }, []);

  const handleCopy = useCallback(async () => {
    const markdown = exportToMarkdown(messages);
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), feedbackMs);
    } catch {
      console.warn("Clipboard write failed");
    }
  }, [messages, feedbackMs]);

  const handleDownload = useCallback(() => {
    const markdown = exportToMarkdown(messages);
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [messages, filename]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={cn(
            "absolute top-4 right-4 rounded-full dark:bg-background dark:hover:bg-muted",
            className,
          )}
          size="icon"
          type="button"
          variant="outline"
          title="Export conversation"
          aria-label="Export conversation"
          {...props}
        >
          {copied ? (
            <CheckIcon className="size-3.5 text-green-500" />
          ) : (
            <ShareIcon className="size-3.5" />
          )}
          <span className="hidden sm:inline ml-1">Export</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={handleCopy}>
          <ClipboardIcon className="size-3.5 mr-2" />
          Copy to Clipboard
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleDownload}>
          <DownloadIcon className="size-3.5 mr-2" />
          Download as File
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

// --- Single-message copy (for per-message hover actions) ---

export type MessageCopyButtonProps = Omit<
  ComponentProps<typeof Button>,
  "onClick"
> & {
  /** Raw markdown text to copy */
  text: string;
  /** Duration in ms to show the success checkmark (default 2000) */
  feedbackMs?: number;
};

export const MessageCopyButton = ({
  text,
  feedbackMs = 2000,
  className,
  children,
  ...props
}: MessageCopyButtonProps) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), feedbackMs);
    } catch {
      console.warn("Clipboard write failed");
    }
  }, [text, feedbackMs]);

  return (
    <Button
      className={cn("size-6 p-0 rounded-md", className)}
      onClick={handleCopy}
      size="icon"
      type="button"
      variant="ghost"
      title="Copy message"
      aria-label="Copy message"
      {...props}
    >
      {children ?? (copied ? <CheckIcon className="size-3 text-green-500" /> : <ClipboardIcon className="size-3" />)}
    </Button>
  );
};
