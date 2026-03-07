import { describe, expect, test } from "bun:test";
import { z } from "zod";

describe("SpawnRequestSchema", () => {
    const schema = z.object({ runnerId: z.string().min(1) }).strict();
    test("validates correctly", () => {
        expect(schema.safeParse({ runnerId: "r-1" }).success).toBe(true);
        expect(schema.safeParse({ runnerId: "" }).success).toBe(false);
    });
});
