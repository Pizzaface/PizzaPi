import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import { Window } from "happy-dom";
import * as React from "react";

mock.module("@/lib/utils", () => ({
    cn: (...classes: Array<string | undefined | null | false>) => classes.filter(Boolean).join(" "),
}));

const approveMock = mock().mockResolvedValue({ error: null });
mock.module("@/lib/auth-client", () => ({
    authClient: { $fetch: approveMock },
    useSession: () => ({ data: { session: null }, isPending: false }),
}));

// Capture the html5-qrcode success callback so tests can simulate a decode.
let decodeCallback: ((text: string) => void) | null = null;
const startMock = mock().mockImplementation(async (_cameraId: unknown, _config: unknown, onDecode: (text: string) => void) => {
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

afterEach(() => {
    cleanup();
    decodeCallback = null;
    approveMock.mockClear();
    startMock.mockClear();
    stopMock.mockClear();
    clearMock.mockClear();
    getCamerasMock.mockClear();
});

describe("DeviceSetupScanner", () => {
    test("shows camera permission prompt and can start scanning", async () => {
        const { getByText } = render(<DeviceSetupScanner onClose={() => {}} />);

        expect(getByText("Allow Camera & Scan")).toBeDefined();
        fireEvent.click(getByText("Allow Camera & Scan"));

        await waitFor(() => expect(getCamerasMock).toHaveBeenCalledTimes(1));
        expect(startMock).toHaveBeenCalledTimes(1);
    });

    test("scanning a QR requires explicit confirmation before approving", async () => {
        const token = "a".repeat(64);
        const { getByText, queryByText } = render(<DeviceSetupScanner onClose={() => {}} />);

        fireEvent.click(getByText("Allow Camera & Scan"));
        await waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
        expect(decodeCallback).not.toBeNull();

        // A decoded QR must NOT auto-approve; it shows a confirmation step.
        decodeCallback!(`http://localhost/?t=${token}`);
        await waitFor(() => expect(getByText("Approve this device")).toBeDefined());
        expect(approveMock).not.toHaveBeenCalled();

        // Only an explicit click approves.
        fireEvent.click(getByText("Approve this device"));
        await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
        expect(approveMock.mock.calls[0][0]).toContain(`/api/setup-claim/${token}/approve`);
        expect(queryByText("Cancel")).toBeNull();
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
