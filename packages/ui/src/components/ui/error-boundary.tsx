import * as React from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

export type ErrorBoundaryLevel = "root" | "section" | "widget";

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Custom fallback UI to render instead of the default error card. */
  fallback?: React.ReactNode;
  /** Controls the size/style of the default fallback UI. */
  level?: ErrorBoundaryLevel;
  /**
   * When any value in this array changes between renders, the boundary
   * automatically resets its error state so children re-render fresh.
   * Use this to clear sticky crashes when context changes (e.g. switching sessions).
   */
  resetKeys?: unknown[];
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * React Error Boundary that catches render errors and displays a fallback UI.
 *
 * Levels:
 * - `"root"` — full-screen centered card (wraps the entire app)
 * - `"section"` — fills its container, used for major UI sections
 * - `"widget"` — compact inline fallback for individual cards/tools
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[ErrorBoundary] Caught render error:", error, info.componentStack);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    // Auto-reset when any resetKey changes — clears sticky crashes on context switches
    // (e.g. switching to a different session after one crashed).
    if (this.state.hasError && this.props.resetKeys) {
      const prevKeys = prevProps.resetKeys ?? [];
      const nextKeys = this.props.resetKeys;
      const changed = nextKeys.some((key, i) => !Object.is(key, prevKeys[i]));
      if (changed) {
        this.setState({ hasError: false, error: null });
      }
    }
  }

  /** Reset error state so children can be re-rendered without a full page reload. */
  resetErrorBoundary = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback != null) {
      return this.props.fallback;
    }

    const { level = "section", } = this.props;
    const { error } = this.state;
    const isDev = import.meta.env.DEV;

    if (level === "widget") {
      return (
        <div
          className={cn(
            "flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-destructive text-xs",
          )}
          role="alert"
        >
          <AlertCircle className="size-3.5 shrink-0" />
          <span className="flex-1 min-w-0 truncate">
            {isDev && error?.message ? error.message : "Render error"}
          </span>
          <button
            type="button"
            onClick={this.resetErrorBoundary}
            className="shrink-0 rounded p-0.5 hover:bg-destructive/20 transition-colors"
            aria-label="Retry"
          >
            <RefreshCw className="size-3" />
          </button>
        </div>
      );
    }

    const isRoot = level === "root";

    return (
      <div
        className={cn(
          "flex items-center justify-center",
          isRoot
            ? "fixed inset-0 z-50 bg-background"
            : "h-full w-full min-h-[200px]",
        )}
        role="alert"
      >
        <div
          className={cn(
            "flex flex-col items-center gap-4 rounded-xl border border-destructive/30 bg-card p-8 shadow-lg text-center",
            isRoot ? "max-w-md w-full mx-4" : "max-w-sm w-full mx-4",
          )}
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <AlertCircle className="size-6 text-destructive" />
          </div>

          <div className="space-y-1.5">
            <h2 className="font-semibold text-lg leading-none tracking-tight">
              Something went wrong
            </h2>
            {isDev && error?.message && (
              <p className="text-sm text-muted-foreground font-mono break-all">
                {error.message}
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={this.resetErrorBoundary}
              className={cn(
                "inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium",
                "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
                "transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
            >
              <RefreshCw className="size-4" />
              Retry
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className={cn(
                "inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium",
                "bg-destructive text-destructive-foreground hover:bg-destructive/90",
                "transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
