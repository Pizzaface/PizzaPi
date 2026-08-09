/**
 * Minimal git commit-graph lane layout.
 *
 * Given commits (newest-first) with their parents, assign each commit to a
 * horizontal "lane" and describe, per row, which lane lines are active and
 * where forks/merges connect — enough to render a readable DAG gutter.
 *
 * This is the classic "git log --graph" lane scheme, simplified: a lane is
 * claimed by the first parent of a child; additional parents (merges) open a
 * new lane that rejoins at the merge commit.
 */

export interface GraphRow {
    hash: string;
    /** Lane this commit's node sits on. */
    nodeLane: number;
    /** Lanes with a vertical line continuing THROUGH this row (excl. node lane). */
    lines: number[];
    /** Horizontal connectors into this row's node lane (merge/fork). */
    joins: Array<{ from: number; to: number }>;
}

export interface GraphInput {
    hash: string;
    parents: string[];
}

export function layoutGraph(entries: GraphInput[]): GraphRow[] {
    const lanes: (string | null)[] = []; // lane tip: hash this lane is waiting to reach
    const rows: GraphRow[] = [];

    for (const e of entries) {
        // Lanes that already point at this commit (a child reached us from multiple
        // paths → this is a merge). All but the reused one become joins.
        const incoming = lanes
            .map((tip, i) => (tip === e.hash ? i : -1))
            .filter((i) => i >= 0);

        // Reuse the lowest incoming lane, or grab a free/empty one.
        let nodeLane = incoming.length > 0 ? incoming[0] : -1;
        if (nodeLane === -1) {
            const free = lanes.indexOf(null);
            nodeLane = free !== -1 ? free : lanes.length;
            if (nodeLane >= lanes.length) lanes.push(null);
        }

        const joins: Array<{ from: number; to: number }> = [];
        // Terminate all other incoming lanes here (merge arms), drawing joins into nodeLane.
        for (const arm of incoming) {
            if (arm === nodeLane) continue;
            joins.push({ from: arm, to: nodeLane });
            lanes[arm] = null;
        }

        // Claim nodeLane for the first parent; extra parents open new lanes.
        if (e.parents.length === 0) {
            lanes[nodeLane] = null;
        } else {
            lanes[nodeLane] = e.parents[0];
            for (let i = 1; i < e.parents.length; i++) {
                let pl = lanes.indexOf(null);
                if (pl === -1) { pl = lanes.length; lanes.push(null); }
                lanes[pl] = e.parents[i];
                joins.push({ from: pl, to: nodeLane });
            }
        }

        // Vertical lines active through this row (any lane still holding a tip).
        const lines = lanes
            .map((tip, i) => (tip !== null && i !== nodeLane ? i : -1))
            .filter((i) => i >= 0);

        // Compact trailing empty lanes so the gutter stays narrow.
        while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

        rows.push({ hash: e.hash, nodeLane, lines, joins });
    }

    return rows;
}
