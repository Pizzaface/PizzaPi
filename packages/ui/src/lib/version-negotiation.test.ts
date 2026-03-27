import { describe, expect, test } from "bun:test";
import { evaluateVersionNegotiation } from "./version-negotiation";

describe("evaluateVersionNegotiation", () => {
    test("detects update available when server version is newer", () => {
        const result = evaluateVersionNegotiation(
            {
                version: {
                    server: "0.2.0",
                    socketProtocol: 1,
                },
            },
            {
                uiVersion: "0.1.32",
                clientSocketProtocol: 1,
            },
        );

        expect(result.serverVersion).toBe("0.2.0");
        expect(result.updateAvailable).toBe(true);
        expect(result.protocolCompatible).toBe(true);
        expect(result.message).toContain("newer than this UI");
    });

    test("reports protocol mismatch with a helpful message", () => {
        const result = evaluateVersionNegotiation(
            {
                version: {
                    server: "0.1.32",
                    socketProtocol: 2,
                },
            },
            {
                uiVersion: "0.1.32",
                clientSocketProtocol: 1,
            },
        );

        expect(result.updateAvailable).toBe(false);
        expect(result.protocolCompatible).toBe(false);
        expect(result.message).toContain("protocol mismatch");
    });

    test("gracefully handles invalid payload", () => {
        const result = evaluateVersionNegotiation(
            { bad: true },
            {
                uiVersion: "0.1.32",
                clientSocketProtocol: 1,
            },
        );

        expect(result.serverVersion).toBeNull();
        expect(result.updateAvailable).toBe(false);
        expect(result.protocolCompatible).toBe(true);
        expect(result.message).toBeNull();
    });
});
