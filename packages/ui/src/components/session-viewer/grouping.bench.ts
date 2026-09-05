/**
 * Run: bun packages/ui/src/components/session-viewer/grouping.bench.ts
 * Measures grouping CPU time, not browser rendering or end-to-end latency.
 * Uses a warmup and five samples; no timing assertions in the test suite.
 */
import { groupToolExecutionMessages } from "./grouping";
import type { RelayMessage } from "./types";

for (const turns of [1000, 5000, 10000]) {
    const messages: RelayMessage[] = [];
    for (let i = 0; i < turns; i++) {
        messages.push(
            {
                key: `a${i}`,
                role: "assistant",
                content: [{ type: "toolCall", id: `tc${i}`, name: "bash", arguments: { command: "pwd" } }],
            },
            { key: `r${i}`, role: "toolResult", toolCallId: `tc${i}`, toolName: "bash", content: "done" },
        );
    }
    groupToolExecutionMessages(messages);
    const samples = Array.from({ length: 5 }, () => {
        const start = performance.now();
        groupToolExecutionMessages(messages);
        return performance.now() - start;
    }).sort((a, b) => a - b);
    console.log(JSON.stringify({ turns, messages: messages.length, medianMs: samples[2] }));
}
