import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import { Window } from "happy-dom";
import * as React from "react";

mock.module("@/lib/utils", () => ({
    cn: (...classes: Array<string | undefined | null | false>) => classes.filter(Boolean).join(" "),
}));

mock.module("@/lib/auth-client", () => ({
    useSession: () => ({ data: { session: null }, isPending: false }),
}));

// Capture the html5-qrcode success callback so tests can simulate a decode.
let decodeCallback: ((text: string) => void) | null = null;
// Whether the preview container was visible at the moment start() measured it.
let readerHiddenAtStart: boolean | null = null;
const startMock = mock().mockImplementation(async (_cameraId: unknown, _config: unknown, onDecode: (text: string) => void) => {
    const reader = document.querySelector('[id$="-qr-reader"]');
    readerHiddenAtStart = reader ? reader.hasAttribute("hidden") : null;
    decodeCallback = onDecode;
});
const stopMock = mock().mockResolvedValue(undefined);
const clearMock = mock();
const getCamerasMock = mock().mockResolvedValue([{ id: "camera-1", label: "Camera" }]);

mock.module("html5-qrcode", () => ({
    Html5Qrcode: class {
        static getCameras = getCamerasMock;
        start = startMock;
        stop = stopMock;
        clear = clearMock;
    },
}));

afterAll(() => mock.restore());

const { DeviceSetupScanner } = await import("./DeviceSetupScanner");

beforeAll(() => {
    const win = new Window({ url: "http://localhost/" });
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (win as any).SyntaxError = SyntaxError;
    (globalThis as any).window = win;
    (globalThis as any).document = win.document;
    (globalThis as any).navigator = win.navigator;
    (globalThis as any).HTMLElement = win.HTMLElement;
    (globalThis as any).Element = win.Element;
    (globalThis as any).Node = win.Node;
    (globalThis as any).SVGElement = win.SVGElement;
    (globalThis as any).Event = win.Event;
    (globalThis as any).MouseEvent = win.MouseEvent;
    (globalThis as any).MutationObserver = (win as any).MutationObserver;
    /* eslint-enable @typescript-eslint/no-explicit-any */
});

const originalFetch = globalThis.fetch;

afterEach(() => {
    cleanup();
    decodeCallback = null;
    startMock.mockClear();
    readerHiddenAtStart = null;
    stopMock.mockClear();
    clearMock.mockClear();
    getCamerasMock.mockClear();
    globalThis.fetch = originalFetch;
});

describe("DeviceSetupScanner", () => {
    test("shows camera permission prompt and can start scanning", async () => {
        const { getByText } = render(<DeviceSetupScanner onClose={() => {}} />);

        expect(getByText("Allow Camera & Scan")).toBeDefined();
        fireEvent.click(getByText("Allow Camera & Scan"));

        await waitFor(() => expect(getCamerasMock).toHaveBeenCalledTimes(1));
        expect(startMock).toHaveBeenCalledTimes(1);
        // Must request the rear lens: cameras[0] is the selfie camera on Android.
        expect(startMock.mock.calls[0][0]).toEqual({ facingMode: "environment" });
        // A display:none container measures 0x0 and the preview renders black.
        expect(readerHiddenAtStart).toBe(false);
    });

    test("scanning a QR requires explicit confirmation before approving", async () => {
        const token = "a".repeat(64);
        const { getByText, queryByText } = render(<DeviceSetupScanner onClose={() => {}} />);

        fireEvent.click(getByText("Allow Camera & Scan"));
        await waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
        expect(decodeCallback).not.toBeNull();

        const fetchMock = mock().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        const approveCalls = () => fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]).includes("/approve"));

        // A decoded QR must NOT auto-approve; it shows a confirmation step.
        decodeCallback!(`http://localhost/?t=${token}`);
        await waitFor(() => expect(getByText("Approve this device")).toBeDefined());
        expect(approveCalls()).toHaveLength(0);

        // Only an explicit click approves.
        fireEvent.click(getByText("Approve this device"));
        await waitFor(() => expect(approveCalls()).toHaveLength(1));
        // Exact path: an auth-client baseURL prefix (/api/auth/...) 404s here.
        expect(approveCalls()[0][0]).toBe(`/api/setup-claim/${token}/approve`);
        expect(queryByText("Cancel")).toBeNull();
    });

    test("shows the claim's label on the confirmation screen when present", async () => {
        globalThis.fetch = mock().mockResolvedValue(
            new Response(JSON.stringify({ status: "pending", relayUrl: "http://x", label: "docker-demo-runner" }), { status: 200 }),
        ) as unknown as typeof fetch;

        const token = "c".repeat(64);
        const { getByText } = render(<DeviceSetupScanner onClose={() => {}} />);

        fireEvent.click(getByText("Allow Camera & Scan"));
        await waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));

        decodeCallback!(`http://localhost/?t=${token}`);
        await waitFor(() => expect(getByText("Approve this device")).toBeDefined());
        await waitFor(() => expect(getByText("docker-demo-runner")).toBeDefined());
    });

    test("confirmation screen is unaffected when the claim has no label", async () => {
        globalThis.fetch = mock().mockResolvedValue(
            new Response(JSON.stringify({ status: "pending", relayUrl: "http://x" }), { status: 200 }),
        ) as unknown as typeof fetch;

        const token = "d".repeat(64);
        const { getByText, queryByText, container } = render(<DeviceSetupScanner onClose={() => {}} />);

        fireEvent.click(getByText("Allow Camera & Scan"));
        await waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));

        decodeCallback!(`http://localhost/?t=${token}`);
        await waitFor(() => expect(getByText("Approve this device")).toBeDefined());
        expect(queryByText("undefined")).toBeNull();
        expect(container.textContent).not.toContain("undefined");
    });

    test("unmounting before the scanner starts does not throw", async () => {
        // html5-qrcode throws a bare string synchronously, which a .catch() on
        // the returned promise would never see.
        stopMock.mockImplementationOnce(() => {
            throw "Cannot stop, scanner is not running or paused.";
        });
        clearMock.mockImplementationOnce(() => {
            throw "Cannot clear while scan is ongoing, close it first.";
        });

        const { getByText, unmount } = render(<DeviceSetupScanner onClose={() => {}} />);
        fireEvent.click(getByText("Allow Camera & Scan"));
        await waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));

        expect(() => unmount()).not.toThrow();
        await waitFor(() => expect(stopMock).toHaveBeenCalled());
    });

    test("initialToken pre-fills the manual approve input", () => {
        const token = "b".repeat(64);
        const { container } = render(<DeviceSetupScanner initialToken={token} onClose={() => {}} />);
        const input = container.querySelector("#setup-token") as HTMLInputElement | null;
        expect(input?.value).toBe(token);
    });

    test("manual token fallback is available", () => {
        const { getByText, container } = render(<DeviceSetupScanner onClose={() => {}} />);

        expect(getByText("Can’t scan? Paste the setup token instead")).toBeDefined();
        expect(container.querySelector("#setup-token")).toBeDefined();
        expect(getByText("Approve")).toBeDefined();
    });
});
