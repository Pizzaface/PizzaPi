import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";

let connectCalls = 0;
let connectImpl: () => Promise<any> = async () => null;

mock.module("../redis-client.js", () => ({
  connectRedisClient: () => {
    connectCalls++;
    return connectImpl();
  },
  // redis-kv-store.ts (pulled in transitively via sio-registry) imports this —
  // a partial mock breaks the whole module graph with a SyntaxError.
  isRedisDisabled: () => false,
}));

const reconcilePromise = import("./reconcile.js");

afterAll(() => mock.restore());
afterEach(async () => {
  const reconcile = await reconcilePromise;
  reconcile._resetRedisForTesting();
  connectCalls = 0;
  connectImpl = async () => null;
});

describe("route reconcile Redis client", () => {
  it("shares concurrent initialization and replaces a closed client", async () => {
    const reconcile = await reconcilePromise;
    let resolveConnect: ((client: any) => void) | undefined;
    connectImpl = () => new Promise((resolve) => {
      resolveConnect = resolve;
    });

    let revision = 0;
    const firstClient = {
      isOpen: true,
      incr: async () => ++revision,
    };
    const first = reconcile.nextReconcileRevision();
    const second = reconcile.nextReconcileRevision();
    expect(connectCalls).toBe(1);
    resolveConnect!(firstClient);
    expect((await Promise.all([first, second])).sort()).toEqual([1, 2]);

    firstClient.isOpen = false;
    const replacement = {
      isOpen: true,
      incr: async () => ++revision,
    };
    connectImpl = async () => replacement;
    expect(await reconcile.nextReconcileRevision()).toBe(3);
    expect(connectCalls).toBe(2);
  });
});
