import { expect, test } from "bun:test";
import { resolveTunnelSession } from "./tunnel-session";

test("tunnel controls follow the active session, with runner-scoped fallback", () => {
    const sessions = [
        { sessionId: "first", runnerId: "r1" },
        { sessionId: "current", runnerId: "r1" },
        { sessionId: "other", runnerId: "r2" },
    ];
    expect(resolveTunnelSession("r1", "current", "first", sessions)).toBe("current");
    expect(resolveTunnelSession("r1", "other", "first", sessions)).toBe("first");
    expect(resolveTunnelSession("r1", null, "ended", sessions)).toBe("first");
    expect(resolveTunnelSession("r1", "ended", "other", sessions)).toBe("first");
    expect(resolveTunnelSession("r3", "current", "first", sessions)).toBeUndefined();
});
