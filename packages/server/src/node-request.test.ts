import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { nodeReqToFetchRequest } from "./node-request.js";

function requestPair() {
    const req = Object.assign(new EventEmitter(), {
        headers: { host: "localhost:3000", "x-pizzapi-client-ip": "spoofed" },
        method: "GET",
        url: "/api/test",
        socket: { remoteAddress: "127.0.0.1" },
    });
    const res = Object.assign(new EventEmitter(), { writableFinished: false });
    return { req, res };
}

describe("nodeReqToFetchRequest", () => {
    test("aborts the fetch request when the client disconnects before the response finishes", () => {
        const { req, res } = requestPair();
        const request = nodeReqToFetchRequest(req as any, res as any, 3000);

        res.emit("close");

        expect(request.signal.aborted).toBe(true);
    });

    test("does not abort after a completed response", () => {
        const { req, res } = requestPair();
        const request = nodeReqToFetchRequest(req as any, res as any, 3000);
        res.writableFinished = true;

        res.emit("close");

        expect(request.signal.aborted).toBe(false);
        expect(request.headers.get("x-pizzapi-client-ip")).toBe("127.0.0.1");
    });
});
