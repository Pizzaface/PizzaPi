import { describe, expect, it } from "bun:test";
import { decideRegisteredParentState } from "./remote-registered-parent-state.js";

describe("decideRegisteredParentState", () => {
    it("links the child when the server reports an active parent link", () => {
        expect(decideRegisteredParentState({
            serverParentSessionId: "parent-1",
            localParentSessionId: null,
            pendingDelinkOwnParent: false,
        })).toEqual({ kind: "link", parentSessionId: "parent-1" });
    });

    it("ignores a stale server parent link while delink_own_parent is pending", () => {
        expect(decideRegisteredParentState({
            serverParentSessionId: "parent-1",
            localParentSessionId: "parent-1",
            pendingDelinkOwnParent: true,
        })).toEqual({ kind: "ignore_stale_server_link" });
    });

    it("treats wasDelinked as an explicit permanent unlink", () => {
        expect(decideRegisteredParentState({
            serverParentSessionId: null,
            localParentSessionId: "parent-1",
            pendingDelinkOwnParent: false,
            wasDelinked: true,
        })).toEqual({ kind: "explicit_delink" });
    });

    it("preserves child mode during a transient parent outage", () => {
        expect(decideRegisteredParentState({
            serverParentSessionId: null,
            localParentSessionId: "parent-1",
            pendingDelinkOwnParent: false,
        })).toEqual({ kind: "transient_offline" });
    });

    it("does nothing when there is no local or remote parent link", () => {
        expect(decideRegisteredParentState({
            serverParentSessionId: null,
            localParentSessionId: null,
            pendingDelinkOwnParent: false,
        })).toEqual({ kind: "no_change" });
    });
});
