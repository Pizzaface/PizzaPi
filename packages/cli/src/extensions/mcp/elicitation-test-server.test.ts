import { describe, expect, test } from "bun:test";
import { createStdioMcpClient } from "./transport-stdio.js";

describe("local elicitation test server", () => {
  test("exercises modern discovery and accepts an MRTR form response", async () => {
    const client = await createStdioMcpClient({
      name: "elicitation-test",
      command: process.execPath,
      args: [new URL("./elicitation-test-server.mjs", import.meta.url).pathname],
    });
    try {
      expect(await client.listTools()).toHaveLength(1);
      const answers: unknown[] = [];
      const result = await client.callTool("ask_for_name", {}, undefined, async params => {
        answers.push(params);
        return { action: "accept", content: { name: "Grace" } };
      });
      expect(answers).toHaveLength(1);
      expect(result.content).toEqual([{ type: "text", text: "Hello, Grace! MRTR response received." }]);
    } finally {
      client.close();
    }
  });
});
