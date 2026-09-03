import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";

const memDb = new Kysely<any>({
  dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
});

// Swappable per-test: the "other query error" case points getKysely at a
// wrapper that fails only the legacy-table SELECT.
let currentDb: any = memDb;

const modsPromise = (async () => {
  mock.module("./auth.js", () => ({
    getKysely: () => currentDb,
    // migrations.ts wraps work in runWithAuthContext; the test calls the
    // migration directly, so a pass-through suffices.
    runWithAuthContext: async (_ctx: unknown, fn: () => Promise<void>) => fn(),
    // routes/utils.js (via setup-claims/mobile-links) reads the rate-limit config.
    getApiKeyRateLimitConfig: () => ({ timeWindowMs: 86_400_000, maxRequests: 10 }),
  }));
  const store = await import("./events/store.js");
  const migrations = await import("./migrations.js");
  return { store, migrations };
})();

afterAll(() => mock.restore());

const NOW = new Date().toISOString();

/** Legacy tables exactly as the old stores created them (minimal columns). */
async function ensureLegacyTables(): Promise<void> {
  await memDb.schema
    .createTable("trigger_subscription")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("sessionId", "text", (c) => c.notNull())
    .addColumn("runnerId", "text", (c) => c.notNull())
    .addColumn("triggerType", "text", (c) => c.notNull())
    .addColumn("subscriptionJson", "text", (c) => c.notNull())
    .addColumn("updatedAt", "text", (c) => c.notNull())
    .execute();
  await memDb.schema
    .createTable("runner_trigger_listener")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("runnerId", "text", (c) => c.notNull())
    .addColumn("triggerType", "text", (c) => c.notNull())
    .addColumn("listenerJson", "text", (c) => c.notNull())
    .addColumn("updatedAt", "text", (c) => c.notNull())
    .execute();
}

async function seedListener(id: string, json: unknown): Promise<void> {
  await memDb
    .insertInto("runner_trigger_listener")
    .values({
      id,
      runnerId: "runner-1",
      triggerType: (json as any).triggerType,
      listenerJson: JSON.stringify(json),
      updatedAt: NOW,
    })
    .execute();
}

describe("legacy trigger migration — params become filters", () => {
  let store: Awaited<typeof modsPromise>["store"];
  let migrations: Awaited<typeof modsPromise>["migrations"];

  beforeAll(async () => {
    ({ store, migrations } = await modsPromise);
    await store.ensureEventTables(); // trigger_route
    await ensureLegacyTables();
    await memDb.schema
      .createTable("runner_owner")
      .ifNotExists()
      .addColumn("runnerId", "text", (c) => c.primaryKey())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("updatedAt", "text", (c) => c.notNull())
      .execute();
  });

  afterEach(async () => {
    await memDb.deleteFrom("trigger_route").execute();
    await memDb.deleteFrom("trigger_subscription").execute();
    await memDb.deleteFrom("runner_trigger_listener").execute();
    await memDb.deleteFrom("runner_owner").execute();
  });

  it("converts listener params (incl *Contains) to AND filters and keeps params", async () => {
    await seedListener("listener:r1:github:check_completed:1:abc", {
      listenerId: "listener:r1:github:check_completed:1:abc",
      triggerType: "github:check_completed",
      prompt: "fix it",
      params: { repo: ["Pizzaface/PizzaPi"], conclusion: ["failure"], branch: "main", bodyContains: "!pizza" },
      createdAt: NOW,
    });

    await migrations.migrateLegacyTriggerData();

    const route = (await store.listRoutes({ eventType: "github:check_completed" }))[0];
    expect(route.filters).toEqual([
      { field: "repo", value: ["Pizzaface/PizzaPi"], op: "eq" },
      { field: "conclusion", value: ["failure"], op: "eq" },
      { field: "branch", value: "main", op: "eq" },
      { field: "body", value: "!pizza", op: "contains" },
    ]);
    expect(route.params).toEqual({ repo: ["Pizzaface/PizzaPi"], conclusion: ["failure"], branch: "main", bodyContains: "!pizza" });
  });

  it("keeps time:* params as schedule config — no filters", async () => {
    await seedListener("listener:r1:time:cron:2:def", {
      listenerId: "listener:r1:time:cron:2:def",
      triggerType: "time:cron",
      params: { cron: "0 9 * * *", label: "Morning" },
      createdAt: NOW,
    });

    await migrations.migrateLegacyTriggerData();

    const route = (await store.listRoutes({ eventType: "time:cron" }))[0];
    expect(route.params).toEqual({ cron: "0 9 * * *", label: "Morning" });
    expect(route.filters).toBeUndefined();
  });

  it("repairs already-migrated rows (params, no filters), idempotently; leaves explicit filters alone", async () => {
    // A row the pre-repair migration created: params only, no filters.
    await store.createRoute(
      {
        eventType: "shortcut:story_commented",
        target: { kind: "spawn", spec: { runnerId: "runner-1" } },
        deliverAs: "followUp",
        params: { author: "jordanpizza", textContains: "!pizza-rift" },
        origin: "api",
      },
      { routeId: "listener:r1:shortcut:story_commented:3:old" },
    );
    // A row the user/explicit API configured with real filters plus params.
    await store.createRoute(
      {
        eventType: "github:pr_comment",
        target: { kind: "spawn", spec: { runnerId: "runner-1" } },
        deliverAs: "followUp",
        params: { repo: "Pizzaface/PizzaPi" },
        filters: [{ field: "body", value: "!pizza", op: "contains" }],
        origin: "ui",
      },
      { routeId: "listener:r1:github:pr_comment:4:keep" },
    );

    await migrations.migrateLegacyTriggerData();
    await migrations.migrateLegacyTriggerData(); // idempotent

    const repaired = (await store.listRoutes({ eventType: "shortcut:story_commented" }))[0];
    expect(repaired.filters).toEqual([
      { field: "author", value: "jordanpizza", op: "eq" },
      { field: "text", value: "!pizza-rift", op: "contains" },
    ]);
    const untouched = (await store.listRoutes({ eventType: "github:pr_comment" }))[0];
    expect(untouched.filters).toEqual([{ field: "body", value: "!pizza", op: "contains" }]);
  });

  it("does not convert params on routes with non-legacy ids", async () => {
    await store.createRoute(
      {
        eventType: "github:pr_comment",
        target: { kind: "session", sessionId: "owned" },
        deliverAs: "followUp",
        params: { repo: "Pizzaface/PizzaPi" },
        origin: "ui",
      },
      { routeId: "rt_fresh" },
    );

    await migrations.migrateLegacyTriggerData();

    const route = (await store.listRoutes({ eventType: "github:pr_comment" }))[0];
    expect(route.filters).toBeUndefined();
    expect(route.params).toEqual({ repo: "Pizzaface/PizzaPi" });
  });

  it("retires legacy rows after migration — user-deleted routes do not resurrect", async () => {
    await memDb.insertInto("trigger_subscription").values({
      id: "sub:resurrect:1",
      sessionId: "owned",
      runnerId: "runner-1",
      triggerType: "godmother:idea_moved",
      subscriptionJson: JSON.stringify({ params: {} }),
      updatedAt: NOW,
    }).execute();
    await memDb.insertInto("runner_trigger_listener").values({
      id: "listener:resurrect:1",
      runnerId: "runner-1",
      triggerType: "github:pr_comment",
      listenerJson: JSON.stringify({ triggerType: "github:pr_comment", prompt: "handle it" }),
      updatedAt: NOW,
    }).execute();

    await migrations.migrateLegacyTriggerData();
    expect(await store.listRoutes({ eventType: "godmother:idea_moved" })).toHaveLength(1);
    expect(await store.listRoutes({ eventType: "github:pr_comment" })).toHaveLength(1);

    // The user deletes the migrated routes, then the server restarts.
    for (const r of await store.listRoutes()) {
      if (r.routeId.startsWith("rt_cfg_")) continue;
      await store.deleteRoute(r.routeId);
    }
    await migrations.migrateLegacyTriggerData();

    // Legacy rows are gone — no resurrection.
    expect(await store.listRoutes({ eventType: "godmother:idea_moved" })).toHaveLength(0);
    expect(await store.listRoutes({ eventType: "github:pr_comment" })).toHaveLength(0);
  });

  it("ignores a missing legacy table (fresh installs) instead of failing", async () => {
    await memDb.schema.dropTable("trigger_subscription").execute();
    await memDb.schema.dropTable("runner_trigger_listener").execute();

    try {
      // Both legacy tables absent — the migration is a clean no-op, not an error.
      const result = await migrations.migrateLegacyTriggerData();
      expect(result).toEqual({ subs: 0, listeners: 0, invalid: 0 });
    } finally {
      await ensureLegacyTables(); // restore for afterEach cleanup
    }
  });

  it("throws on a legacy-table query error that is not a missing table — startup fails loudly", async () => {
    // A non-missing-table failure (disk I/O, corruption, ...): swallowing it
    // as "no rows" would mark the migration complete and silently deactivate
    // every unmigrated schedule.
    currentDb = {
      selectFrom: (table: string) => {
        if (table === "trigger_subscription") throw new Error("disk I/O error");
        return memDb.selectFrom(table);
      },
    };
    try {
      await expect(migrations.migrateLegacyTriggerData()).rejects.toThrow("disk I/O error");
    } finally {
      currentDb = memDb;
    }
  });

  it("leaves corrupt legacy listener rows in place, warns, and counts them", async () => {
    // Unparseable JSON — can never produce a route.
    await memDb.insertInto("runner_trigger_listener").values({
      id: "listener:corrupt:1",
      runnerId: "runner-1",
      triggerType: "github:pr_comment",
      listenerJson: "{not valid json",
      updatedAt: NOW,
    }).execute();
    // Shape-invalid: parseable, but the JSON carries no triggerType.
    await memDb.insertInto("runner_trigger_listener").values({
      id: "listener:shapeless:1",
      runnerId: "runner-1",
      triggerType: "github:pr_comment",
      listenerJson: JSON.stringify({ prompt: "no type" }),
      updatedAt: NOW,
    }).execute();
    // A valid row migrates normally alongside them.
    await seedListener("listener:good:1", { triggerType: "github:pr_comment", prompt: "handle it" });

    const result = await migrations.migrateLegacyTriggerData();

    expect(result.listeners).toBe(1);
    expect(result.invalid).toBe(2);
    // Corrupt rows are PRESERVED — a row is only deleted after its route was
    // successfully created.
    const remaining = await memDb.selectFrom("runner_trigger_listener").selectAll().execute();
    expect(remaining.map((r: any) => r.id).sort()).toEqual(["listener:corrupt:1", "listener:shapeless:1"]);
    expect(await store.getRoute("listener:corrupt:1")).toBeNull();
    expect(await store.getRoute("listener:shapeless:1")).toBeNull();
    expect(await store.getRoute("listener:good:1")).not.toBeNull();
  });
});