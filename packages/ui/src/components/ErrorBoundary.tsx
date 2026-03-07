import * as React from "react";
import { AlertTriangle, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  showDetails: boolean;
}

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  fallbackRender?: (props: { error: Error; errorInfo: React.ErrorInfo | null; resetError: () => void; }) => React.ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  componentLabel?: string;
  className?: string;
  compact?: boolean;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null, showDetails: false };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ errorInfo });
    console.error(`[ErrorBoundary${this.props.componentLabel ? `: ${this.props.componentLabel}` : ""}] Caught error:`, error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  resetError = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null, showDetails: false });
  };

  toggleDetails = (): void => {
    this.setState((prev) => ({ showDetails: !prev.showDetails }));
  };

  render(): React.ReactNode {
    const { hasError, error, errorInfo, showDetails } = this.state;
    const { children, fallback, fallbackRender, componentLabel, className, compact } = this.props;

    if (!hasError || !error) return children;
    if (fallbackRender) return fallbackRender({ error, errorInfo, resetError: this.resetError });
    if (fallback) return fallback;

    if (compact) {
      return (
        <div className={cn("flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive", className)}>
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <span className="truncate">{componentLabel ? `${componentLabel} error` : "Something went wrong"}</span>
          <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-destructive hover:bg-destructive/20 hover:text-destructive" onClick={this.resetError}>
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      );
    }

    return (
      <div className={cn("flex flex-col items-center justify-center gap-4 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center", className)} role="alert">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-6 w-6 text-destructive" />
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-semibold text-foreground">{componentLabel ? `${componentLabel} Error` : "Something went wrong"}</h3>
          <p className="text-sm text-muted-foreground">An unexpected error occurred. You can try again or refresh the page.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={this.resetError}><RefreshCw className="mr-2 h-4 w-4" />Try Again</Button>
          <Button variant="ghost" size="sm" onClick={this.toggleDetails} className="text-muted-foreground">
            {showDetails ? <><ChevronUp className="mr-1 h-4 w-4" />Hide Details</> : <><ChevronDown className="mr-1 h-4 w-4" />Show Details</>}
          </Button>
        </div>
        {showDetails && (
          <div className="mt-2 w-full max-w-lg overflow-hidden rounded-md border border-border bg-muted/50">
            <div className="max-h-48 overflow-auto p-3 text-left">
              <p className="mb-2 font-mono text-xs text-destructive">{error.message}</p>
              {errorInfo?.componentStack && <pre className="whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">{errorInfo.componentStack}</pre>}
            </div>
          </div>
        )}
      </div>
    );
  }
}

export function withErrorBoundary<P extends object>(Component: React.ComponentType<P>, errorBoundaryProps?: Omit<ErrorBoundaryProps, "children">): React.FC<P> {
  const WrappedComponent: React.FC<P> = (props) => <ErrorBoundary {...errorBoundaryProps}><Component {...props} /></ErrorBoundary>;
  WrappedComponent.displayName = `withErrorBoundary(\${Component.displayName || Component.name || "Component"})`;
  return WrappedComponent;
}

export default ErrorBoundary;
