import { describe, expect, test, mock } from "bun:test";

mock.module("@/lib/viewer-socket-context", () => ({
  useViewerSocket: () => null,
}));

const { getEagerServiceAvailability } = await import("./useServiceChannel");

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
