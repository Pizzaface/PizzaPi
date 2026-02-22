import * as React from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getRelayWsBase } from "@/lib/relay";
import { Button } from "@/components/ui/button";
import { TerminalIcon, X, Maximize2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";

const MOBILE_SHORTCUTS: { label: string; data: string }[] = [
  { label: "Tab", data: "\t" },
  { label: "Esc", data: "\x1b" },
  { label: "Ctrl+C", data: "\x03" },
  { label: "Ctrl+D", data: "\x04" },
  { label: "Ctrl+L", data: "\x0c" },
  { label: "Ctrl+A", data: "\x01" },
  { label: "Ctrl+E", data: "\x05" },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
  { label: "←", data: "\x1b[D" },
  { label: "→", data: "\x1b[C" },
  { label: "PgUp", data: "\x1b[5~" },
  { label: "PgDn", data: "\x1b[6~" },
  { label: "Home", data: "\x1b[H" },
  { label: "End", data: "\x1b[F" },
];

export interface WebTerminalProps {
  terminalId: string;
  onClose?: () => void;
  className?: string;
}

export function WebTerminal({ terminalId, onClose, className }: WebTerminalProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const xtermRef = React.useRef<XTerm | null>(null);
  const fitAddonRef = React.useRef<FitAddon | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const [status, setStatus] = React.useState<"connecting" | "connected" | "disconnected" | "error">("connecting");
  const [isMaximized, setIsMaximized] = React.useState(false);

  React.useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace",
      theme: {
        background: "#09090b",
        foreground: "#fafafa",
        cursor: "#fafafa",
        selectionBackground: "#3f3f46",
        black: "#09090b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#fafafa",
        brightBlack: "#52525b",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#ffffff",
      },
      allowProposedApi: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(containerRef.current);
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Initial fit
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    // Connect to relay terminal WebSocket
    const wsBase = getRelayWsBase();
    const ws = new WebSocket(`${wsBase}/ws/terminal/${terminalId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connecting");
    };

    ws.onmessage = (evt) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(evt.data as string);
      } catch {
        return;
      }

      if (msg.type === "terminal_connected") {
        setStatus("connected");
        term.focus();
        // Send initial size — this also triggers the deferred PTY spawn on the
        // server, so we must always send it (fall back to 80x24 if layout isn't ready).
        const dims = fitAddon.proposeDimensions();
        ws.send(JSON.stringify({
          type: "terminal_resize",
          cols: dims?.cols ?? 80,
          rows: dims?.rows ?? 24,
        }));
        return;
      }

      if (msg.type === "terminal_ready") {
        setStatus("connected");
        return;
      }

      if (msg.type === "terminal_data") {
        const data = typeof msg.data === "string" ? msg.data : "";
        if (data) {
          const decoded = atob(data);
          term.write(decoded);
        }
        return;
      }

      if (msg.type === "terminal_exit") {
        const exitCode = typeof msg.exitCode === "number" ? msg.exitCode : 0;
        term.writeln(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m`);
        setStatus("disconnected");
        return;
      }

      if (msg.type === "terminal_error") {
        const message = typeof msg.message === "string" ? msg.message : "Unknown error";
        term.writeln(`\r\n\x1b[31m[Error: ${message}]\x1b[0m`);
        setStatus("error");
        return;
      }
    };

    ws.onerror = () => {
      setStatus("error");
    };

    ws.onclose = () => {
      if (status !== "error") {
        setStatus("disconnected");
      }
    };

    // Forward terminal input → WebSocket
    const inputDisposable = term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "terminal_input",
          data: btoa(data),
        }));
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (fitAddonRef.current) {
          fitAddonRef.current.fit();
          const dims = fitAddonRef.current.proposeDimensions();
          if (dims && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: "terminal_resize",
              cols: dims.cols,
              rows: dims.rows,
            }));
          }
        }
      });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      inputDisposable.dispose();
      resizeObserver.disconnect();
      ws.close();
      wsRef.current = null;
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [terminalId]);

  // Re-fit when maximized state changes
  React.useEffect(() => {
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
    });
  }, [isMaximized]);

  const handleClose = React.useCallback(() => {
    // Send kill signal before closing
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "kill_terminal" }));
    }
    onClose?.();
  }, [onClose]);

  const statusColor = {
    connecting: "text-yellow-500",
    connected: "text-green-500",
    disconnected: "text-zinc-500",
    error: "text-red-500",
  }[status];

  const statusLabel = {
    connecting: "Connecting…",
    connected: "Connected",
    disconnected: "Disconnected",
    error: "Error",
  }[status];

  const sendShortcut = React.useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "terminal_input", data: btoa(data) }));
    }
  }, []);

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950",
        isMaximized && "fixed inset-0 z-50 rounded-none border-0",
        className,
      )}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between border-zinc-800 border-b px-3 py-1.5 bg-zinc-900/50 min-h-[44px] md:min-h-0">
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <TerminalIcon className="size-3.5" />
          <span>Terminal</span>
          <span className={cn("text-[10px]", statusColor)}>● {statusLabel}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-9 md:size-6 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
            onClick={() => setIsMaximized((v) => !v)}
          >
            {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-9 md:size-6 text-zinc-400 hover:text-red-400 hover:bg-zinc-800"
            onClick={handleClose}
          >
            <X size={14} />
          </Button>
        </div>
      </div>
      {/* Terminal container */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 p-1"
        style={{ minHeight: isMaximized ? undefined : 300 }}
      />
      {/* Mobile keyboard shortcut bar */}
      <div className="md:hidden flex items-center gap-1.5 border-t border-zinc-800 bg-zinc-900/70 px-2 py-2 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {MOBILE_SHORTCUTS.map(({ label, data }) => (
          <button
            key={label}
            className="flex-shrink-0 rounded bg-zinc-800 px-3 py-1.5 text-xs font-mono text-zinc-300 active:bg-zinc-600 select-none touch-manipulation min-w-[40px] text-center"
            onPointerDown={(e) => {
              // Prevent the button from stealing focus away from the terminal
              e.preventDefault();
              sendShortcut(data);
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
