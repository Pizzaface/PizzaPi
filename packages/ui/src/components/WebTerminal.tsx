import * as React from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { io, type Socket } from "socket.io-client";
import type { TerminalServerToClientEvents, TerminalClientToServerEvents } from "@pizzapi/protocol";
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
  const wsRef = React.useRef<Socket<TerminalServerToClientEvents, TerminalClientToServerEvents> | null>(null);
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

    // Initial fit — try immediately and then retry after short delays to
    // handle mobile browsers where flex layout may not be settled in the
    // first animation frame (e.g. inside a freshly-shown fixed overlay).
    const doFit = () => { if (fitAddonRef.current) fitAddonRef.current.fit(); };
    requestAnimationFrame(doFit);
    const retryTimer1 = setTimeout(doFit, 50);
    const retryTimer2 = setTimeout(doFit, 200);

    // Connect to relay terminal via Socket.IO
    const socket: Socket<TerminalServerToClientEvents, TerminalClientToServerEvents> = io("/terminal", {
      auth: { terminalId },
      withCredentials: true,
    });
    wsRef.current = socket;

    socket.on("terminal_connected", () => {
      setStatus("connected");
      // Only auto-focus on non-touch devices — on mobile, focusing the xterm
      // textarea immediately triggers the virtual keyboard, which resizes the
      // visual viewport and covers the terminal before it has a chance to fit.
      if (!window.matchMedia("(pointer: coarse)").matches) {
        term.focus();
      }
      // Send initial size — this also triggers the deferred PTY spawn on the
      // server, so we must always send it (fall back to 80x24 if layout isn't ready).
      // Re-fit first so proposeDimensions reflects the current layout.
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      socket.emit("terminal_resize", {
        terminalId,
        cols: dims?.cols ?? 80,
        rows: dims?.rows ?? 24,
      });
    });

    socket.on("terminal_ready", () => {
      setStatus("connected");
    });

    socket.on("terminal_data", (data) => {
      const raw = typeof data.data === "string" ? data.data : "";
      if (raw) {
        const decoded = atob(raw);
        term.write(decoded);
      }
    });

    socket.on("terminal_exit", (data) => {
      const exitCode = typeof data.exitCode === "number" ? data.exitCode : 0;
      term.writeln(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m`);
      setStatus("disconnected");
    });

    socket.on("terminal_error", (data) => {
      const message = typeof data.message === "string" ? data.message : "Unknown error";
      term.writeln(`\r\n\x1b[31m[Error: ${message}]\x1b[0m`);
      setStatus("error");
    });

    socket.on("connect_error", () => {
      setStatus("error");
    });

    socket.on("disconnect", () => {
      setStatus("disconnected");
    });

    // Forward terminal input → Socket.IO
    //
    // xterm.js fires onData for BOTH user keystrokes AND terminal query
    // responses (DA, DA2, CPR, OSC replies, DECRPM).  Over a network relay
    // those responses arrive at the PTY long after the shell timed-out
    // waiting for them, so they get echoed as visible garbage.  Strip them
    // here — shells always have fallbacks when responses don't arrive.
    const TERM_RESPONSE_RE =
      // eslint-disable-next-line no-control-regex
      /\x1b\[[?>!]?[\d;]*[cRny]|\x1b\][\d;][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/g;

    const inputDisposable = term.onData((data: string) => {
      if (socket.connected) {
        const filtered = data.replace(TERM_RESPONSE_RE, "");
        if (filtered.length > 0) {
          socket.emit("terminal_input", {
            terminalId,
            data: btoa(filtered),
          });
        }
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (fitAddonRef.current) {
          fitAddonRef.current.fit();
          const dims = fitAddonRef.current.proposeDimensions();
          if (dims && wsRef.current?.connected) {
            wsRef.current.emit("terminal_resize", {
              terminalId,
              cols: dims.cols,
              rows: dims.rows,
            });
          }
        }
      });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      clearTimeout(retryTimer1);
      clearTimeout(retryTimer2);
      inputDisposable.dispose();
      resizeObserver.disconnect();
      socket.disconnect();
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
    if (wsRef.current?.connected) {
      wsRef.current.emit("kill_terminal", { terminalId });
    }
    onClose?.();
  }, [onClose, terminalId]);

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
    if (wsRef.current?.connected) {
      wsRef.current.emit("terminal_input", { terminalId, data: btoa(data) });
    }
  }, [terminalId]);

  // Ref for the mobile shortcut bar container so we can attach a non-passive
  // touchstart listener.  React's synthetic event delegation runs too late for
  // e.preventDefault() to suppress the iOS virtual keyboard — the browser
  // decides to show/restore the keyboard before the delegated handler fires.
  // Attaching directly to the DOM node with { passive: false } intercepts the
  // event early enough to reliably prevent the keyboard from appearing.
  const shortcutBarRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const bar = shortcutBarRef.current;
    if (!bar) return;
    const handler = (e: TouchEvent) => {
      // Prevent focus from shifting to any element (which would show the
      // virtual keyboard).  We send terminal input via the socket directly so
      // xterm focus is not required.
      e.preventDefault();
    };
    bar.addEventListener("touchstart", handler, { passive: false });
    return () => bar.removeEventListener("touchstart", handler);
  }, []);

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950",
        isMaximized && "fixed inset-0 z-50 rounded-none border-0",
        className,
      )}
    >
      {/* Header bar — compact status + controls */}
      <div className="flex items-center justify-between border-zinc-800 border-b px-3 py-1 bg-zinc-900/50 min-h-[36px] md:min-h-0">
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
          <span className={cn("text-[10px]", statusColor)}>●</span>
          <span className={statusColor}>{statusLabel}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 md:size-5 text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800"
            onClick={() => setIsMaximized((v) => !v)}
          >
            {isMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 md:size-5 text-zinc-500 hover:text-red-400 hover:bg-zinc-800"
            onClick={handleClose}
          >
            <X size={12} />
          </Button>
        </div>
      </div>
      {/* Terminal container — needs an explicit min-height so FitAddon has
          something to measure if the flex height chain hasn't fully resolved
          yet (common in mobile fixed overlays). Use a dvh-based cap so it
          never overflows the screen on landscape phones. */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 p-1"
        style={{ minHeight: isMaximized ? undefined : "min(300px, calc(100dvh - 120px))" }}
      />
      {/* Mobile keyboard shortcut bar — non-passive touchstart is attached via
          shortcutBarRef useEffect above to reliably suppress the iOS keyboard */}
      <div
        ref={shortcutBarRef}
        className="md:hidden flex items-center gap-1.5 border-t border-zinc-800 bg-zinc-900/70 px-2 py-2 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        {MOBILE_SHORTCUTS.map(({ label, data }) => (
          <button
            key={label}
            // tabIndex={-1} keeps the button out of the tab order and further
            // prevents focus management from triggering the virtual keyboard.
            tabIndex={-1}
            className="flex-shrink-0 rounded bg-zinc-800 px-3 py-1.5 text-xs font-mono text-zinc-300 active:bg-zinc-600 select-none touch-manipulation min-w-[40px] text-center"
            onPointerDown={(e) => {
              // Belt-and-suspenders: also preventDefault here for non-touch
              // pointer devices and for browsers where the touchstart listener
              // may not have fired (e.g. desktop with touch emulation).
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
