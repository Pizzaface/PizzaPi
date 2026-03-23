/**
 * Render-based integration tests for the ErrorBoundary component.
 *
 * These tests actually mount the component in a DOM (via happy-dom) and
 * verify observable behaviour: fallback UI, button wiring, dev/prod message
 * display, custom fallback prop, level-specific markup, and resetKeys recovery.
 *
 * They complement the logic-mirroring tests in error-boundary.test.ts, which
 * cover the pure state-machine behaviour without a DOM dependency.
 */

import { beforeAll, afterEach, describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import { render, fireEvent, act, cleanup } from "@testing-library/react";
import React from "react";

// Mock @/lib/utils (cn) so this test runs from the repo root where
// packages/ui/bunfig.toml path aliases aren't applied.
// Must be called before the dynamic import of the component.
mock.module("@/lib/utils", () => ({
	cn: (...classes: (string | undefined | null | false)[]) =>
		classes.filter(Boolean).join(" "),
}));

// Dynamically imported after mock.module so the alias is already intercepted.
const { ErrorBoundary } = await import("./error-boundary");

// ── DOM setup ────────────────────────────────────────────────────────────────

beforeAll(() => {
	const win = new Window({ url: "http://localhost/" });
	// Expose the globals that React and @testing-library/react need.
	// We cast to `any` because happy-dom types don't perfectly match the TS
	// lib DOM types, but the runtime objects are compatible enough.
	/* eslint-disable @typescript-eslint/no-explicit-any */
	(globalThis as any).window = win;
	(globalThis as any).document = win.document;
	(globalThis as any).navigator = win.navigator;
	(globalThis as any).HTMLElement = win.HTMLElement;
	(globalThis as any).Element = win.Element;
	(globalThis as any).Event = win.Event;
	(globalThis as any).MouseEvent = win.MouseEvent;
	(globalThis as any).MutationObserver = (win as any).MutationObserver;
	/* eslint-enable @typescript-eslint/no-explicit-any */
});

afterEach(() => {
	cleanup(); // unmount and remove rendered trees between tests
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Renders ErrorBoundary with a child that unconditionally throws `message`.
 * React logs uncaught errors to console.error; we silence that noise.
 */
function renderCrashed(
	message: string,
	props: Omit<React.ComponentProps<typeof ErrorBoundary>, "children"> = {},
) {
	const Bomb = () => {
		throw new Error(message);
	};
	const origConsoleError = console.error;
	console.error = () => {}; // suppress React's "caught render error" log
	const result = render(
		<ErrorBoundary {...props}>
			<Bomb />
		</ErrorBoundary>,
	);
	console.error = origConsoleError;
	return result;
}

// ── 1. Fallback appears when a child throws ───────────────────────────────────

describe("ErrorBoundary render: fallback activation", () => {
	test("renders role=alert fallback when child throws (widget level)", () => {
		const { container } = renderCrashed("boom", { level: "widget" });
		expect(container.innerHTML).toContain('role="alert"');
	});

	test("renders role=alert fallback when child throws (section level)", () => {
		const { container } = renderCrashed("boom", { level: "section" });
		expect(container.innerHTML).toContain('role="alert"');
	});

	test("renders role=alert fallback when child throws (root level)", () => {
		const { container } = renderCrashed("boom", { level: "root" });
		expect(container.innerHTML).toContain('role="alert"');
	});

	test("renders children normally when no error is thrown", () => {
		const { container } = render(
			<ErrorBoundary>
				<div>All good</div>
			</ErrorBoundary>,
		);
		expect(container.innerHTML).toContain("All good");
		expect(container.innerHTML).not.toContain('role="alert"');
	});
});

// ── 2. Custom fallback prop ───────────────────────────────────────────────────

describe("ErrorBoundary render: custom fallback prop", () => {
	test("uses the custom fallback node instead of the default UI", () => {
		const CustomFallback = () => <div id="custom-fallback">Custom error UI</div>;
		const Bomb = () => {
			throw new Error("crash");
		};
		const origConsoleError = console.error;
		console.error = () => {};
		const { container } = render(
			<ErrorBoundary fallback={<CustomFallback />}>
				<Bomb />
			</ErrorBoundary>,
		);
		console.error = origConsoleError;
		expect(container.innerHTML).toContain("Custom error UI");
		expect(container.innerHTML).not.toContain("Something went wrong");
	});
});

// ── 3. Dev vs prod message display ───────────────────────────────────────────

describe("ErrorBoundary render: dev vs prod message display", () => {
	test("prod mode (DEV=false): shows generic 'Render error' for widget level", () => {
		// Ensure DEV is falsy (default in bun test environment)
		(import.meta.env as Record<string, unknown>).DEV = false;
		const { container } = renderCrashed("Secret internal message", { level: "widget" });
		expect(container.innerHTML).toContain("Render error");
		expect(container.innerHTML).not.toContain("Secret internal message");
		delete (import.meta.env as Record<string, unknown>).DEV;
	});

	test("dev mode (DEV=true): shows actual error message for widget level", () => {
		(import.meta.env as Record<string, unknown>).DEV = true;
		const { container } = renderCrashed("Specific dev error", { level: "widget" });
		expect(container.innerHTML).toContain("Specific dev error");
		expect(container.innerHTML).not.toContain("Render error");
		delete (import.meta.env as Record<string, unknown>).DEV;
	});

	test("prod mode: section/root level does NOT show error message", () => {
		(import.meta.env as Record<string, unknown>).DEV = false;
		const { container } = renderCrashed("Hidden error text", { level: "section" });
		expect(container.innerHTML).not.toContain("Hidden error text");
		delete (import.meta.env as Record<string, unknown>).DEV;
	});

	test("dev mode: section/root level shows error message", () => {
		(import.meta.env as Record<string, unknown>).DEV = true;
		const { container } = renderCrashed("Visible dev error", { level: "section" });
		expect(container.innerHTML).toContain("Visible dev error");
		delete (import.meta.env as Record<string, unknown>).DEV;
	});
});

// ── 4. Retry button is wired up ───────────────────────────────────────────────

describe("ErrorBoundary render: retry button resets the boundary", () => {
	test("clicking Retry clears the fallback and re-renders children", async () => {
		let shouldThrow = true;
		const Recoverable = () => {
			if (shouldThrow) throw new Error("crash");
			return <div>Recovered!</div>;
		};
		const origConsoleError = console.error;
		console.error = () => {};
		const { container } = render(
			<ErrorBoundary level="widget">
				<Recoverable />
			</ErrorBoundary>,
		);
		console.error = origConsoleError;

		// Verify fallback is shown
		expect(container.innerHTML).toContain("Render error");

		// Find and click the retry button via getElementsByTagName
		// (querySelector with attribute selectors has a happy-dom v20 bug)
		const buttons = container.getElementsByTagName("button");
		expect(buttons.length).toBeGreaterThan(0);

		const retryBtn = buttons[0];
		expect(retryBtn.getAttribute("aria-label")).toBe("Retry");

		// Allow the recovery to succeed
		shouldThrow = false;
		await act(async () => {
			fireEvent.click(retryBtn);
		});

		expect(container.innerHTML).toContain("Recovered!");
		expect(container.innerHTML).not.toContain("Render error");
	});

	test("section/root level has a Retry button (text label)", async () => {
		let shouldThrow = true;
		const Recoverable = () => {
			if (shouldThrow) throw new Error("crash");
			return <div>Back to normal</div>;
		};
		const origConsoleError = console.error;
		console.error = () => {};
		const { container } = render(
			<ErrorBoundary level="section">
				<Recoverable />
			</ErrorBoundary>,
		);
		console.error = origConsoleError;

		expect(container.innerHTML).toContain("Something went wrong");

		// There should be at least two buttons: Retry and Reload
		const buttons = container.getElementsByTagName("button");
		expect(buttons.length).toBeGreaterThanOrEqual(2);

		// First button should be "Retry"
		const retryBtn = buttons[0];
		expect(retryBtn.textContent).toContain("Retry");

		shouldThrow = false;
		await act(async () => {
			fireEvent.click(retryBtn);
		});

		expect(container.innerHTML).toContain("Back to normal");
	});
});

// ── 5. resetKeys prop triggers auto-recovery ──────────────────────────────────

describe("ErrorBoundary render: resetKeys prop triggers auto-recovery", () => {
	test("changing a resetKey clears the boundary without user interaction", async () => {
		let shouldThrow = true;
		const Recoverable = () => {
			if (shouldThrow) throw new Error("crash");
			return <div>Session loaded!</div>;
		};
		const origConsoleError = console.error;
		console.error = () => {};
		const { container, rerender } = render(
			<ErrorBoundary level="widget" resetKeys={["session-1"]}>
				<Recoverable />
			</ErrorBoundary>,
		);
		console.error = origConsoleError;

		expect(container.innerHTML).toContain("Render error");

		shouldThrow = false;
		await act(async () => {
			rerender(
				<ErrorBoundary level="widget" resetKeys={["session-2"]}>
					<Recoverable />
				</ErrorBoundary>,
			);
		});

		expect(container.innerHTML).toContain("Session loaded!");
		expect(container.innerHTML).not.toContain("Render error");
	});

	test("unchanged resetKeys do NOT clear the boundary", async () => {
		const Bomb = () => {
			throw new Error("permanent crash");
		};
		const origConsoleError = console.error;
		console.error = () => {};
		const { container, rerender } = render(
			<ErrorBoundary level="widget" resetKeys={["session-1"]}>
				<Bomb />
			</ErrorBoundary>,
		);
		console.error = origConsoleError;

		expect(container.innerHTML).toContain("Render error");

		await act(async () => {
			console.error = () => {};
			rerender(
				<ErrorBoundary level="widget" resetKeys={["session-1"]}>
					<Bomb />
				</ErrorBoundary>,
			);
			console.error = origConsoleError;
		});

		// Still showing fallback — same resetKeys, no recovery
		expect(container.innerHTML).toContain("Render error");
	});

	test("going from null to a session ID resets the boundary", async () => {
		let shouldThrow = true;
		const Recoverable = () => {
			if (shouldThrow) throw new Error("crash");
			return <div>Session active!</div>;
		};
		const origConsoleError = console.error;
		console.error = () => {};
		const { container, rerender } = render(
			<ErrorBoundary level="widget" resetKeys={[null]}>
				<Recoverable />
			</ErrorBoundary>,
		);
		console.error = origConsoleError;

		expect(container.innerHTML).toContain("Render error");

		shouldThrow = false;
		await act(async () => {
			rerender(
				<ErrorBoundary level="widget" resetKeys={["session-new"]}>
					<Recoverable />
				</ErrorBoundary>,
			);
		});

		expect(container.innerHTML).toContain("Session active!");
	});
});

// ── 6. Level-specific markup differences ─────────────────────────────────────

describe("ErrorBoundary render: level-specific fallback markup", () => {
	test("widget level renders compact inline fallback (no heading)", () => {
		const { container } = renderCrashed("boom", { level: "widget" });
		const html = container.innerHTML;
		expect(html).toContain('role="alert"');
		// Widget uses span, not h2
		expect(html).not.toContain("<h2");
	});

	test("section level renders card with 'Something went wrong' heading", () => {
		const { container } = renderCrashed("boom", { level: "section" });
		expect(container.innerHTML).toContain("Something went wrong");
	});

	test("root level renders card with 'Something went wrong' heading", () => {
		const { container } = renderCrashed("boom", { level: "root" });
		expect(container.innerHTML).toContain("Something went wrong");
	});

	test("section level defaults when level prop is omitted", () => {
		// Default level is 'section'
		const { container } = renderCrashed("boom");
		expect(container.innerHTML).toContain("Something went wrong");
	});
});
