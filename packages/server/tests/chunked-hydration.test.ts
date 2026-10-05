/**
 * Chunked (large) sessions hydrate viewers like non-chunked ones: the relay
 * assembles the chunks, viewers get only message-less progress plus ONE
 * tail-truncated session_active, and older pages come from load_messages
 * against the assembled state.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer } from "./harness/server.js";
import { TestScenario } from "./harness/scenario.js";
import type { TestServer } from "./harness/types.js";
import { getLatestCachedSnapshotEvent } from "../src/sessions/redis.js";

const TIMEOUT = 30_000;
let server: TestServer;

beforeAll(async () => {
    server = await createTestServer();
}, TIMEOUT);

afterAll(async () => {
    if (!server) return;
    await server.io.disconnectSockets(true);
    await new Promise<void>((r) => setTimeout(r, 100));
    const httpServer = (server.io as unknown as { httpServer?: { closeAllConnections?(): void } }).httpServer;
    httpServer?.closeAllConnections?.();
    await server.cleanup();
}, TIMEOUT);

type Evt = Record<string, any>;
const msg = (i: number) => ({ role: "user", content: `m${i}`, timestamp: 1_000 + i });

describe("chunked session hydration", () => {
    test("viewers get a truncated snapshot after server assembly, not the chunks", async () => {
        const scenario = new TestScenario();
        scenario.setServer(server);
        try {
            const session = await scenario.addSession({ cwd: "/chunked" });
            const viewer = await scenario.addViewer(session.sessionId);
            let seq = 0;
            const emit = (event: unknown) => session.relay.emitEvent(session.sessionId, session.token, event, seq++);

            const total = 120;
            emit({
                type: "session_active",
                state: { sessionName: "big", messages: [], chunked: true, snapshotId: "snap-1", totalMessages: total },
            });
            emit({ type: "session_messages_chunk", snapshotId: "snap-1", chunkIndex: 0, totalChunks: 2, totalMessages: total, messages: Array.from({ length: 60 }, (_, i) => msg(i)), final: false });
            // Arrives mid-assembly: newer than the snapshot, so must follow it.
            emit({ type: "message_start", message: { role: "user", content: "next", timestamp: 9_999 } });
            emit({ type: "session_messages_chunk", snapshotId: "snap-1", chunkIndex: 1, totalChunks: 2, totalMessages: total, messages: Array.from({ length: 60 }, (_, i) => msg(60 + i)), final: true });

            await viewer.waitForEvent((e) => (e as Evt)?.type === "message_start", 5_000);
            const received = viewer.getReceivedEvents();
            const events = received.map((r) => r.event as Evt);

            const chunks = events.filter((e) => e.type === "session_messages_chunk");
            expect(chunks.length).toBeGreaterThan(0);
            for (const c of chunks) expect(c.messages).toBeUndefined();
            expect(chunks[0].loadedMessages).toBe(60);
            expect(chunks[0].totalMessages).toBe(total);

            const actives = events.filter((e) => e.type === "session_active");
            expect(actives).toHaveLength(1);
            const state = actives[0].state;
            expect(state.chunked).toBeUndefined();
            expect(state.sessionName).toBe("big");
            expect(state.hasMore).toBe(true);
            expect(state.totalMessages).toBe(total);
            expect(state.oldestLoadedIndex).toBe(70);
            expect(state.messages).toHaveLength(50);
            expect(state.messages[0].content).toBe("m70");

            // Order and seq: snapshot precedes the deferred event, seqs increase.
            const saIdx = events.indexOf(actives[0]);
            const msIdx = events.findIndex((e) => e.type === "message_start");
            expect(saIdx).toBeLessThan(msIdx);
            expect(received[msIdx].seq!).toBeGreaterThan(received[saIdx].seq!);

            // The replay cache keeps the full assembled state, not the tail.
            const cached = await getLatestCachedSnapshotEvent(session.sessionId);
            expect(cached?.event.type).toBe("session_active");
            expect((cached?.event.state as Evt).messages).toHaveLength(total);

            // Older pages come from the assembled state.
            const page = await new Promise<Evt>((resolve) => {
                viewer.socket.once("session_messages_page", (d: unknown) => resolve(d as Evt));
                viewer.socket.emit("load_messages", { sessionId: session.sessionId, before: 70, limit: 50 });
            });
            expect(page.messages).toHaveLength(50);
            expect(page.messages[0].content).toBe("m20");
            expect(page.hasMore).toBe(true);
            expect(page.oldestIndex).toBe(20);
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);

    test("a viewer joining mid-assembly is hydrated by the finalize broadcast", async () => {
        const scenario = new TestScenario();
        scenario.setServer(server);
        try {
            const session = await scenario.addSession({ cwd: "/chunked-join" });
            let seq = 0;
            const emit = (event: unknown) => session.relay.emitEvent(session.sessionId, session.token, event, seq++);
            // The runner must not be asked to restart a transfer that is in flight.
            let runnerSignals = 0;
            session.relay.socket.on("connected" as any, () => { runnerSignals++; });

            emit({ type: "session_active", state: { messages: [], chunked: true, snapshotId: "snap-2", totalMessages: 80 } });
            emit({ type: "session_messages_chunk", snapshotId: "snap-2", chunkIndex: 0, totalChunks: 2, totalMessages: 80, messages: Array.from({ length: 40 }, (_, i) => msg(i)), final: false });
            await new Promise((r) => setTimeout(r, 200));

            const viewer = await scenario.addViewer(session.sessionId);
            await new Promise((r) => setTimeout(r, 100));
            const signalsBeforeFinal = runnerSignals;
            emit({ type: "session_messages_chunk", snapshotId: "snap-2", chunkIndex: 1, totalChunks: 2, totalMessages: 80, messages: Array.from({ length: 40 }, (_, i) => msg(40 + i)), final: true });

            const sa = await viewer.waitForEvent((e) => (e as Evt)?.type === "session_active", 5_000) as Evt;
            expect(sa.state.messages).toHaveLength(50);
            expect(sa.state.oldestLoadedIndex).toBe(30);
            expect(signalsBeforeFinal).toBe(0);
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);
    test("a rejected chunk stream leaves a recovery marker so viewers re-request a runner snapshot (review R10)", async () => {
        const scenario = new TestScenario();
        scenario.setServer(server);
        try {
            const session = await scenario.addSession({ cwd: "/chunked-rejected" });
            let seq = 0;
            const emit = (event: unknown) => session.relay.emitEvent(session.sessionId, session.token, event, seq++);
            let runnerSignals = 0;
            session.relay.socket.on("connected" as any, () => { runnerSignals++; });

            // An older, complete snapshot is cached.
            emit({ type: "session_active", state: { sessionName: "old", messages: [msg(0)] } });
            // A newer chunked snapshot is rejected (chunkIndex out of range).
            // Its events are ACKed, so the runner believes it was delivered.
            emit({ type: "session_active", state: { messages: [], chunked: true, snapshotId: "snap-bad", totalMessages: 4 } });
            emit({ type: "session_messages_chunk", snapshotId: "snap-bad", chunkIndex: 7, totalChunks: 2, totalMessages: 4, messages: [msg(1), msg(2)], final: false });
            await new Promise((r) => setTimeout(r, 300));

            const viewer = await scenario.addViewer(session.sessionId);
            const sa = await viewer.waitForEvent((e) => (e as Evt)?.type === "session_active", 5_000) as Evt;
            expect(sa.state.sessionName).toBe("old");
            // The cache hit must NOT suppress recovery: the runner is asked
            // for a fresh snapshot instead of leaving the viewer on the old one.
            const deadline = Date.now() + 3_000;
            while (runnerSignals === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
            expect(runnerSignals).toBeGreaterThan(0);

            // The runner answers with a valid snapshot; the marker clears and
            // later cache hits suppress the runner signal again.
            emit({ type: "session_active", state: { sessionName: "fresh", messages: [msg(0), msg(1), msg(2)] } });
            await viewer.waitForEvent((e) => (e as Evt)?.type === "session_active" && (e as Evt).state?.sessionName === "fresh", 5_000);
            const signalsBefore = runnerSignals;
            const viewer2 = await scenario.addViewer(session.sessionId);
            const sa2 = await viewer2.waitForEvent((e) => (e as Evt)?.type === "session_active", 5_000) as Evt;
            expect(sa2.state.sessionName).toBe("fresh");
            await new Promise((r) => setTimeout(r, 300));
            expect(runnerSignals).toBe(signalsBefore);
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);
});
