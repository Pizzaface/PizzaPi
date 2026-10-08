import type { PublishEventInput, SourceIdentity, SpawnFailureDetails } from "@pizzapi/protocol";
import type { EngineDeps } from "../../events/engine.js";
import { publishEvent } from "../../events/engine.js";

export function buildChildSpawnFailureEvent(args: {
    sessionId: string;
    parentSessionId: string;
    failure: SpawnFailureDetails;
}): PublishEventInput {
    const detail = args.failure.detail || "Child session failed";
    return {
        type: "lifecycle:session_complete",
        summary: `Child session failed: ${detail}`,
        payload: {
            summary: `Child session ${args.sessionId} failed: ${detail}`,
            exitReason: "error",
            exitCode: args.failure.exitCode ?? 1,
            failure: {
                kind: args.failure.kind,
                detail: args.failure.detail,
                exitCode: args.failure.exitCode ?? null,
            },
        },
        responseContract: { actions: ["ack", "followUp"] },
        fireId: `spawn-failure:${args.sessionId}`,
    };
}

export async function publishChildSpawnFailure(
    args: {
        sessionId: string;
        parentSessionId?: string;
        failure?: SpawnFailureDetails;
        userId?: string;
    },
    deps: EngineDeps,
): Promise<boolean> {
    if (!args.parentSessionId || !args.failure || !args.userId) return false;
    const source: SourceIdentity = {
        kind: "session",
        id: args.sessionId,
        name: "spawn_session failure",
        auth: "internal",
        userId: args.userId,
    };
    await publishEvent(
        buildChildSpawnFailureEvent({
            sessionId: args.sessionId,
            parentSessionId: args.parentSessionId,
            failure: args.failure,
        }),
        source,
        deps,
        [{ sessionId: args.parentSessionId, deliverAs: "steer" }],
    );
    return true;
}
