import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import { Window } from "happy-dom";
import * as React from "react";

mock.module("@/lib/utils", () => ({
    cn: (...classes: Array<string | undefined | null | false>) => classes.filter(Boolean).join(" "),
}));

const approveMock = mock();
mock.module("@/lib/auth-client", () => ({
    authClient: {},
    useSession: () => ({ data: { session: null }, isPending: false }),
    $fetch: approveMock,
}));

const startMock = mock().mockResolvedValue(undefined);
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

    test("manual token fallback is available", () => {
        const { getByText, container } = render(<DeviceSetupScanner onClose={() => {}} />);

        expect(getByText("Can’t scan? Paste the setup token instead")).toBeDefined();
        expect(container.querySelector("#setup-token")).toBeDefined();
        expect(getByText("Approve")).toBeDefined();
    });
});
