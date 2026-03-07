import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as React from "react";
import { ErrorBoundary } from "./ErrorBoundary";

let consoleErrorSpy: ReturnType<typeof spyOn>;
beforeEach(() => { consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { consoleErrorSpy.mockRestore(); });

describe("ErrorBoundary", () => {
  test("getDerivedStateFromError returns state with hasError true", () => {
    const testError = new Error("Test error");
    const result = ErrorBoundary.getDerivedStateFromError(testError);
    expect(result).toEqual({ hasError: true, error: testError });
  });

  test("initial state has no error", () => {
    const boundary = new ErrorBoundary({ children: null });
    expect(boundary.state.hasError).toBe(false);
  });

  test("resetError resets state via setState", () => {
    const boundary = new ErrorBoundary({ children: null });
    let capturedState: any = null;
    boundary.setState = ((u: any) => { capturedState = typeof u === "function" ? u(boundary.state) : u; }) as any;
    boundary.resetError();
    expect(capturedState?.hasError).toBe(false);
  });

  test("componentDidCatch logs error", () => {
    const boundary = new ErrorBoundary({ children: null });
    const testError = new Error("Test error");
    const testErrorInfo = { componentStack: "test stack" } as React.ErrorInfo;
    boundary.componentDidCatch(testError, testErrorInfo);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test("render returns children when no error", () => {
    const boundary = new ErrorBoundary({ children: null });
    const childElement = React.createElement("div", null, "Child content");
    boundary.props = { children: childElement };
    expect(boundary.render()).toBe(childElement);
  });
});

describe("withErrorBoundary HOC", () => {
  const { withErrorBoundary } = require("./ErrorBoundary");
  test("returns a function component", () => {
    const TestComponent = () => React.createElement("div", null, "Test");
    const Wrapped = withErrorBoundary(TestComponent);
    expect(typeof Wrapped).toBe("function");
  });
});
