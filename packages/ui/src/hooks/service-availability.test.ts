/**
 * Tests for getEagerServiceAvailability — the pure function extracted from
 * useServiceChannel so it can be tested without module mocks.
 *
 * Previously lived in useServiceChannel.test.ts and required mock.module()
 * to stub React context imports.  That caused cross-file mock pollution
 * in Bun's shared worker: TunnelPanel.test.tsx mocks useServiceChannel
 * with a hardcoded `() => false` stub, and when both files ran in the same
 * worker the dynamic import in useServiceChannel.test.ts could resolve to
 * the mock instead of the real module.
 */
import { describe, expect, test } from "bun:test";
import { getEagerServiceAvailability } from "./service-availability";

describe("getEagerServiceAvailability", () => {
    test("returns true when socket has cached service ids including the requested service", () => {
        const socket = { __serviceIds: ["terminal", "tunnel"] };
        expect(getEagerServiceAvailability(socket, "tunnel")).toBe(true);
    });

    test("returns false when socket is missing cached service ids", () => {
        expect(getEagerServiceAvailability({}, "tunnel")).toBe(false);
        expect(getEagerServiceAvailability(null, "tunnel")).toBe(false);
    });

    test("returns false when cached ids do not include the requested service", () => {
        const socket = { __serviceIds: ["terminal", "git"] };
        expect(getEagerServiceAvailability(socket, "tunnel")).toBe(false);
    });
});
