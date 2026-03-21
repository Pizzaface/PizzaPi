import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import { getKysely } from "./auth.js";
import { unsubscribePush } from "./push.js";

beforeAll(async () => {
    await getKysely().schema
        .createTable("push_subscription")
        .ifNotExists()
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("userId", "text", (col) => col.notNull())
        .addColumn("endpoint", "text", (col) => col.notNull())
        .addColumn("keys", "text", (col) => col.notNull())
        .addColumn("createdAt", "text", (col) => col.notNull())
        .addColumn("enabledEvents", "text", (col) => col.notNull().defaultTo("*"))
        .execute();
});

afterEach(async () => {
    await getKysely().deleteFrom("push_subscription" as any).execute();
});

describe("unsubscribePush", () => {
    it("returns true when a matching subscription is deleted", async () => {
        const db = getKysely();
        const now = new Date().toISOString();
        await db
            .insertInto("push_subscription" as any)
            .values({
                id: "sub-1",
                userId: "user-1",
                endpoint: "https://example.com/push/1",
                keys: "{}",
                createdAt: now,
                enabledEvents: "*",
            })
            .execute();

        const result = await unsubscribePush("user-1", "https://example.com/push/1");
        expect(result).toBe(true);
    });

    it("returns false when no matching subscription exists", async () => {
        const result = await unsubscribePush("user-1", "https://example.com/push/nonexistent");
        expect(result).toBe(false);
    });

    it("returns false when userId does not match", async () => {
        const db = getKysely();
        const now = new Date().toISOString();
        await db
            .insertInto("push_subscription" as any)
            .values({
                id: "sub-2",
                userId: "user-1",
                endpoint: "https://example.com/push/2",
                keys: "{}",
                createdAt: now,
                enabledEvents: "*",
            })
            .execute();

        const result = await unsubscribePush("wrong-user", "https://example.com/push/2");
        expect(result).toBe(false);
    });
});
