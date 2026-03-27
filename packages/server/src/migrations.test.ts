import { describe, expect, test } from "bun:test";
import { summarizePendingBetterAuthMigrations } from "./migrations";

describe("summarizePendingBetterAuthMigrations", () => {
    test("reports no pending work when plan is empty", () => {
        const summary = summarizePendingBetterAuthMigrations({
            toBeCreated: [],
            toBeAdded: [],
        });

        expect(summary).toEqual({
            hasPending: false,
            tablesToCreate: 0,
            fieldsToAdd: 0,
        });
    });

    test("counts table creates and field additions", () => {
        const summary = summarizePendingBetterAuthMigrations({
            toBeCreated: [{ table: "user" }, { table: "session" }],
            toBeAdded: [
                { table: "account", fields: { provider: "text", token: "text" } },
                { table: "session", fields: { userAgent: "text" } },
            ],
        });

        expect(summary).toEqual({
            hasPending: true,
            tablesToCreate: 2,
            fieldsToAdd: 3,
        });
    });
});
