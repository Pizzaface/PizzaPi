import { describe, expect, test } from "bun:test";
import { parseHandshakeProtocolVersion } from "./auth";

describe("parseHandshakeProtocolVersion", () => {
    test("returns numeric protocolVersion directly", () => {
        const socket = {
            handshake: { auth: { protocolVersion: 3 } },
        } as any;

        expect(parseHandshakeProtocolVersion(socket)).toBe(3);
    });

    test("parses integer protocolVersion from string", () => {
        const socket = {
            handshake: { auth: { protocolVersion: "4" } },
        } as any;

        expect(parseHandshakeProtocolVersion(socket)).toBe(4);
    });

    test("returns undefined for invalid values", () => {
        const socket = {
            handshake: { auth: { protocolVersion: "v1" } },
        } as any;

        expect(parseHandshakeProtocolVersion(socket)).toBeUndefined();
    });
});
