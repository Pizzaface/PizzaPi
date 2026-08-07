import { describe, test, expect } from "bun:test";
import { layoutGraph } from "./git-graph";

describe("layoutGraph", () => {
    test("linear history stays on one lane", () => {
        const rows = layoutGraph([
            { hash: "a", parents: ["b"] },
            { hash: "b", parents: ["c"] },
            { hash: "c", parents: [] },
        ]);
        expect(rows.map((r) => r.nodeLane)).toEqual([0, 0, 0]);
        expect(rows.every((r) => r.joins.length === 0)).toBe(true);
    });

    test("branch fork opens a second lane that rejoins at the fork", () => {
        // a1b2c3d → f9e8d7c → c0ffee1; 8a5f1b2 (main) → c0ffee1
        const rows = layoutGraph([
            { hash: "a1b2c3d", parents: ["f9e8d7c"] },
            { hash: "f9e8d7c", parents: ["c0ffee1"] },
            { hash: "8a5f1b2", parents: ["c0ffee1"] },
            { hash: "c0ffee1", parents: ["b2d3e4f"] },
        ]);
        // Both branches share the fork commit: the second branch runs on lane 1,
        // and the fork (c0ffee1) merges it back in (a join into its node lane).
        expect(rows[2].nodeLane).toBe(1); // main tip on its own lane
        expect(rows[3].hash).toBe("c0ffee1");
        expect(rows[3].joins.some((j) => j.from === 1 && j.to === rows[3].nodeLane)).toBe(true);
    });

    test("merge commit with two parents draws a join from the second parent lane", () => {
        const rows = layoutGraph([
            { hash: "m", parents: ["p1", "p2"] },
            { hash: "p1", parents: ["base"] },
            { hash: "p2", parents: ["base"] },
            { hash: "base", parents: [] },
        ]);
        expect(rows[0].nodeLane).toBe(0);
        expect(rows[0].joins.length).toBe(1); // one extra parent arm joins in
        // Both parents resolve back to base.
        expect(rows[3].hash).toBe("base");
    });

    test("root commit produces no joins and terminates its lane", () => {
        const rows = layoutGraph([{ hash: "r", parents: [] }]);
        expect(rows).toHaveLength(1);
        expect(rows[0].nodeLane).toBe(0);
        expect(rows[0].joins).toEqual([]);
        expect(rows[0].lines).toEqual([]);
    });
});
