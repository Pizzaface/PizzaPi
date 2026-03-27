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

    test("detects stale tab when build timestamps differ (same semver, newer server)", () => {
        const result = evaluateVersionNegotiation(
            {
                version: {
                    server: "0.1.32",
                    socketProtocol: 1,
                    buildTimestamp: "2024-06-02T10:00:00.000Z",
                },
            },
            {
                uiVersion: "0.1.32",
                clientSocketProtocol: 1,
                uiBuildTimestamp: "2024-06-01T10:00:00.000Z",
            },
        );

        expect(result.updateAvailable).toBe(true);
        expect(result.serverBuildTimestamp).toBe("2024-06-02T10:00:00.000Z");
        expect(result.message).toContain("newer version");
    });

    test("no false positive when build timestamps match", () => {
        const ts = "2024-06-01T10:00:00.000Z";
        const result = evaluateVersionNegotiation(
            {
                version: {
                    server: "0.1.32",
                    socketProtocol: 1,
                    buildTimestamp: ts,
                },
            },
            {
                uiVersion: "0.1.32",
                clientSocketProtocol: 1,
                uiBuildTimestamp: ts,
            },
        );

        expect(result.updateAvailable).toBe(false);
        expect(result.message).toBeNull();
    });

    test("no false positive when client is newer than server (rollback scenario)", () => {
        const result = evaluateVersionNegotiation(
            {
                version: {
                    server: "0.1.32",
                    socketProtocol: 1,
                    buildTimestamp: "2024-06-01T10:00:00.000Z",
                },
            },
            {
                uiVersion: "0.1.32",
                clientSocketProtocol: 1,
                uiBuildTimestamp: "2024-06-02T10:00:00.000Z",
            },
        );

        // Server is OLDER than the UI — do not prompt refresh (rollback scenario)
        expect(result.updateAvailable).toBe(false);
        expect(result.message).toBeNull();
    });

    test("no false positive when uiBuildTimestamp is not provided", () => {
        const result = evaluateVersionNegotiation(
            {
                version: {
                    server: "0.1.32",
                    socketProtocol: 1,
                    buildTimestamp: "2024-06-02T10:00:00.000Z",
                },
            },
            {
                uiVersion: "0.1.32",
                clientSocketProtocol: 1,
                // uiBuildTimestamp deliberately omitted (e.g. local dev build)
            },
        );

        expect(result.updateAvailable).toBe(false);
        expect(result.message).toBeNull();
    });

    test("exposes serverBuildTimestamp from payload", () => {
        const ts = "2024-06-02T10:00:00.000Z";
        const result = evaluateVersionNegotiation(
            {
                version: {
                    server: "0.1.32",
                    socketProtocol: 1,
                    buildTimestamp: ts,
                },
            },
            {
                uiVersion: "0.1.32",
                clientSocketProtocol: 1,
            },
        );

        expect(result.serverBuildTimestamp).toBe(ts);
    });
});
