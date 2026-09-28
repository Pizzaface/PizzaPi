import { afterAll, describe, expect, it, mock } from "bun:test";

const serverRoot = new URL("../../../../server/src/", import.meta.url).pathname;
type RelayedResponse = { sessionId: string; data: { triggerId: string; response: string; action?: string; targetSessionId?: string } };
const capture: { relayed?: RelayedResponse } = {};
const getRelayedResponse = (): RelayedResponse | undefined => capture.relayed;
let recipient = "";
const localSocket = {
  connected: true,
  emit: (_event: string, data: { triggerId: string; response: string; action?: string; targetSessionId?: string }) => {
    capture.relayed = { sessionId: recipient, data };
  },
};

mock.module(`${serverRoot}ws/sio-registry.js`, () => ({
  broadcastToSessionViewers: () => {},
  countSocketsInRoomCluster: async () => ({ kind: "unknown" }),
  getIo: () => null,
  runnerRoom: (id: string) => `runner:${id}`,
  emitToRelaySessionAcked: async () => false,
  emitToRelaySessionVerified: async () => false,
  emitToRunner: () => {},
  getLocalRunnerSocket: () => null,
  getLocalTuiSocket: (sessionId: string) => {
    recipient = sessionId;
    return sessionId === "parent" ? localSocket : null;
  },
  getSharedSession: async () => null,
  linkSessionToRunner: async () => {},
  recordRunnerSession: async () => {},
  waitForLocalTuiSocket: async () => null,
}));

const serverTransportUrl = new URL("../../../../server/src/events/transport.js", import.meta.url).href;
const { emitDeliveryResponseRelay } = await import(serverTransportUrl);
const { receivedTriggers } = await import("./extension.js");
const { handleTriggerResponse } = await import("../remote/connection.js");

afterAll(() => {
  receivedTriggers.clear();
  mock.restore();
});

describe("completion response transport to parent handler", () => {
  it("correlates a completion ack with the parent's received delivery key", async () => {
    delete capture.relayed;
    recipient = "";
    const deliveryId = "dlv_parent_completion";
    const delivery = {
      deliveryId,
      eventId: "evt_completion",
      sessionId: "parent",
      status: "responded",
      response: { action: "ack", text: "Done" },
    };
    const event = {
      eventId: "evt_completion",
      type: "lifecycle:session_complete",
      fireId: "child-fire-id",
      source: { kind: "session", id: "child", auth: "socket", userId: "user" },
      payload: {},
    };
    receivedTriggers.set(deliveryId, { sourceSessionId: "child", type: event.type, trackedAt: Date.now() });

    expect(await emitDeliveryResponseRelay(delivery as any, event as any)).toBe(true);
    const response = getRelayedResponse();
    if (!response) throw new Error("transport did not relay the completion response");
    expect(response.sessionId).toBe("parent");
    expect(response.data).toEqual({
      triggerId: deliveryId,
      response: "Done",
      action: "ack",
      targetSessionId: "parent",
    });

    const emitted: string[] = [];
    handleTriggerResponse({
      relay: { token: "test" },
      sioSocket: { connected: true, emit: (name: string) => emitted.push(name) },
    } as any, response.data);
    expect(emitted).toContain("cleanup_child_session");
  });
});
