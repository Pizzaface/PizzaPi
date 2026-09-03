import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";

const memDb = new Kysely<any>({
  dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
});

const modsPromise = (async () => {
  mock.module("../auth.js", () => ({ getKysely: () => memDb }));
  mock.module("../ws/sio-registry.js", () => ({
    getSharedSession: async (id: string) =>
      id === "s1" ? { userId: "user-x", runnerId: "runner-9", cwd: "/ws" } : null,
  }));
  const store = await import("./store.js");
  const cfg = await import("./config-routes.js");
  return { store, cfg };
})();

afterAll(() => mock.restore());

const VALID = {
  routes: [
    { eventType: "github:pr_comment", target: { kind: "session", sessionId: "s1" }, deliverAs: "followUp" },
    { eventType: "schedule:nightly", target: { kind: "spawn", spec: { runnerId: "r1", cwd: "/tmp" } }, deliverAs: "steer" },
  ],
};

describe("config routes", () => {
  let store: Awaited<typeof modsPromise>["store"];
  let cfg: Awaited<typeof modsPromise>["cfg"];

  beforeAll(async () => {
    ({ store, cfg } = await modsPromise);
    await store.ensureEventTables();
  });

  it("parses and validates the file shape", () => {
    const routes = cfg.parseRoutesFile(JSON.stringify(VALID));
    expect(routes).toHaveLength(2);
    expect(routes.every((r) => r.origin === "config")).toBe(true);
    expect(() => cfg.parseRoutesFile("not json")).toThrow(/valid JSON/);
    expect(() => cfg.parseRoutesFile("{}")).toThrow(/routes.*array/);
    expect(() =>
      cfg.parseRoutesFile(JSON.stringify({ routes: [{ eventType: "bad", target: { kind: "session", sessionId: "s" }, deliverAs: "steer" }] })),
    ).toThrow(/invalid eventType/);
  });

  it("syncs from a file and clears when the file goes away", async () => {
    const dir = mkdtempSync(join(tmpdir(), "routes-"));
    const file = join(dir, "routes.json");
    writeFileSync(file, JSON.stringify(VALID));

    expect(await cfg.loadConfigRoutes(file)).toBe(2);
    expect(await store.listRoutes()).toHaveLength(2);

    // No file configured → config routes are cleared
    expect(await cfg.loadConfigRoutes(undefined)).toBe(0);
    expect(await store.listRoutes()).toHaveLength(0);
  });

  it("keeps existing config routes on a read error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "routes-"));
    const file = join(dir, "routes.json");
    writeFileSync(file, JSON.stringify(VALID));
    await cfg.loadConfigRoutes(file);
    expect(await cfg.loadConfigRoutes(join(dir, "missing.json"))).toBe(0);
    expect(await store.listRoutes()).toHaveLength(2);
  });

  it("stamps session targets with their runner so runner reconcile sees config routes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "routes-"));
    const file = join(dir, "routes.json");
    writeFileSync(file, JSON.stringify(VALID));
    await cfg.loadConfigRoutes(file);
    const [gh] = await store.listRoutes({ eventType: "github:pr_comment" });
    expect(gh !== null && gh.target.kind === "session" && gh.target.runnerId).toBe("runner-9");
    // Spawn-target routes are untouched.
    const [sched] = await store.listRoutes({ eventType: "schedule:nightly" });
    expect(sched?.target.kind).toBe("spawn");
  });
});
