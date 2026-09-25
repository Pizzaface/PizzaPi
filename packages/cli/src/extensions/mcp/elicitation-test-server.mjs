#!/usr/bin/env node
// Local MCP 2026-07-28 fixture for manually exercising PizzaPi form elicitation.
// Configure as a stdio server; call ask_for_name from a PizzaPi session.
let buffer = "";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function handle(message) {
  if (message.method === "server/discover") {
    return respond(message.id, { supportedVersions: ["2026-07-28"] });
  }
  if (message.method === "initialize") {
    return respond(message.id, { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "elicitation-test", version: "1.0.0" } });
  }
  if (message.method === "tools/list") {
    return respond(message.id, { tools: [{
      name: "ask_for_name",
      description: "Ask the user for their name via MCP form elicitation, then greet them.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }] });
  }
  if (message.method === "tools/call") {
    const params = message.params ?? {};
    const response = params.inputResponses?.name_request;
    if (!response) {
      return respond(message.id, {
        resultType: "input_required",
        requestState: "local-fixture-name-request",
        inputRequests: {
          name_request: {
            method: "elicitation/create",
            params: {
              mode: "form",
              message: "Please enter a name so the test server can greet you.",
              requestedSchema: {
                type: "object",
                properties: {
                  name: { type: "string", title: "Your name", minLength: 2, maxLength: 80, default: "Ada" },
                },
                required: ["name"],
              },
            },
          },
        },
      });
    }
    if (response.action !== "accept") {
      return respond(message.id, { content: [{ type: "text", text: `Elicitation ${response.action}; no name collected.` }] });
    }
    const name = response.content?.name;
    if (typeof name !== "string") {
      return respond(message.id, { content: [{ type: "text", text: "Missing name in accepted response." }], isError: true });
    }
    return respond(message.id, { content: [{ type: "text", text: `Hello, ${name}! MRTR response received.` }] });
  }
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); }
    catch (error) { process.stderr.write(`${error}\n`); }
  }
});
