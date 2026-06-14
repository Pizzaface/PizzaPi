import { describe, expect, mock, spyOn, test } from "bun:test";
import { ServiceRegistry } from "./service-handler.js";
import type { ServiceHandler, ServiceInitOptions } from "./service-handler.js";
import type { Socket } from "socket.io-client";

function makeMockSocket(): Socket {
    return {
        on: mock(() => {}),
        off: mock(() => {}),
        emit: mock(() => {}),
    } as unknown as Socket;
}

describe("ServiceRegistry", () => {
    test("initAll initializes every handler with the same socket and options", () => {
        const registry = new ServiceRegistry();
        const socket = makeMockSocket();
        const options: ServiceInitOptions = { isShuttingDown: () => false };
        const initCalls: Array<{ id: string; socket: Socket; options: ServiceInitOptions }> = [];

        const makeHandler = (id: string): ServiceHandler => ({
            id,
            init(receivedSocket, receivedOptions) {
                initCalls.push({ id, socket: receivedSocket, options: receivedOptions });
            },
            dispose() {},
        });

        registry.register(makeHandler("alpha"));
        registry.register(makeHandler("beta"));

        registry.initAll(socket, options);

        expect(initCalls).toEqual([
            { id: "alpha", socket, options },
            { id: "beta", socket, options },
        ]);
    });

    test("disposeAll continues disposing remaining handlers after one throws", () => {
        const registry = new ServiceRegistry();
        const disposed: string[] = [];
        const stderrWrite = spyOn(process.stderr, "write").mockImplementation(() => true as any);

        try {
            registry.register({
                id: "throws",
                init() {},
                dispose() {
                    disposed.push("throws");
                    throw new Error("dispose failed");
                },
            });
            registry.register({
                id: "after",
                init() {},
                dispose() {
                    disposed.push("after");
                },
            });

            expect(() => registry.disposeAll()).not.toThrow();
            expect(disposed).toEqual(["throws", "after"]);
        } finally {
            stderrWrite.mockRestore();
        }
    });
});
