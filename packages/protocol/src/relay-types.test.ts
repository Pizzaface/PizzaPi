// ============================================================================
// relay-types.test.ts — Compile-time type tests for relay protocol events
//
// Verifies that the new session_completion and metadata fields are correctly
// typed in the relay protocol interfaces. These are mostly compile-time
// checks — if the file compiles, the types are correct.
// ============================================================================

import { describe, it, expect } from "bun:test";
import type {
    RelayClientToServerEvents,
    RelayServerToClientEvents,
} from "./relay.js";
import type { SessionInfo } from "./shared.js";

describe("relay protocol types", () => {
    describe("RelayClientToServerEvents", () => {
        it("session_completion event has correct shape", () => {
            // Type-level test: ensure the event type is assignable
            const handler: RelayClientToServerEvents["session_completion"] = (data) => {
                // These fields must exist
                const _sessionId: string = data.sessionId;
                const _token: string = data.token;
                const _result: string = data.result;
                // These fields are optional
                const _tokenUsage: Record<string, unknown> | undefined = data.tokenUsage;
                const _error: string | undefined = data.error;

                // Use them to avoid unused warnings
                void [_sessionId, _token, _result, _tokenUsage, _error];
            };
            expect(handler).toBeFunction();
        });

        it("session_message supports optional metadata", () => {
            const handler: RelayClientToServerEvents["session_message"] = (data) => {
                const _token: string = data.token;
                const _target: string = data.targetSessionId;
                const _message: string = data.message;
                const _metadata: Record<string, unknown> | undefined = data.metadata;
                void [_token, _target, _message, _metadata];
            };
            expect(handler).toBeFunction();
        });

        it("register supports optional parentSessionId", () => {
            const handler: RelayClientToServerEvents["register"] = (data) => {
                const _cwd: string = data.cwd;
                const _parentSessionId: string | null | undefined = data.parentSessionId;
                void [_cwd, _parentSessionId];
            };
            expect(handler).toBeFunction();
        });
    });

    describe("RelayServerToClientEvents", () => {
        it("session_completion event has correct shape", () => {
            const handler: RelayServerToClientEvents["session_completion"] = (data) => {
                const _sessionId: string = data.sessionId;
                const _parentSessionId: string = data.parentSessionId;
                const _result: string = data.result;
                const _tokenUsage: Record<string, unknown> | undefined = data.tokenUsage;
                const _error: string | undefined = data.error;
                void [_sessionId, _parentSessionId, _result, _tokenUsage, _error];
            };
            expect(handler).toBeFunction();
        });

        it("session_message supports optional metadata", () => {
            const handler: RelayServerToClientEvents["session_message"] = (data) => {
                const _from: string = data.fromSessionId;
                const _message: string = data.message;
                const _ts: string = data.ts;
                const _metadata: Record<string, unknown> | undefined = data.metadata;
                void [_from, _message, _ts, _metadata];
            };
            expect(handler).toBeFunction();
        });
    });

    describe("SessionInfo", () => {
        it("includes optional parentSessionId and childSessionIds", () => {
            const info: SessionInfo = {
                sessionId: "test",
                shareUrl: "http://example.com/session/test",
                cwd: "/tmp",
                startedAt: new Date().toISOString(),
                sessionName: null,
                isEphemeral: true,
                isActive: false,
                lastHeartbeatAt: null,
                model: null,
                runnerId: null,
                runnerName: null,
                // New fields — both optional
                parentSessionId: "parent-123",
                childSessionIds: ["child-1", "child-2"],
            };

            expect(info.parentSessionId).toBe("parent-123");
            expect(info.childSessionIds).toEqual(["child-1", "child-2"]);
        });

        it("works without parentSessionId and childSessionIds (backward compatible)", () => {
            const info: SessionInfo = {
                sessionId: "test",
                shareUrl: "http://example.com/session/test",
                cwd: "/tmp",
                startedAt: new Date().toISOString(),
                sessionName: null,
                isEphemeral: true,
                isActive: false,
                lastHeartbeatAt: null,
                model: null,
                runnerId: null,
                runnerName: null,
                // Omit new fields — should compile fine
            };

            expect(info.parentSessionId).toBeUndefined();
            expect(info.childSessionIds).toBeUndefined();
        });
    });
});
