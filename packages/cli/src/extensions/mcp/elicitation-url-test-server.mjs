#!/usr/bin/env bun
// Local MCP 2026-07-28 fixture for manually exercising PizzaPi URL-mode elicitation.
// Configure as a stdio server; call connect_account from a PizzaPi session.
// No real credentials: the "browser step" is a local page with a Complete button.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

let buffer = "";
const flows = new Map(); // requestState -> { done: boolean }
const port = Number(process.env.PIZZAPI_ELICITATION_URL_PORT ?? 0);

const http = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const id = url.searchParams.get("flow") ?? "";
  const flow = flows.get(id);
  if (!flow) { res.writeHead(404).end("unknown flow"); return; }
  if (url.pathname === "/complete") {
    flow.done = true;
    res.writeHead(200, { "content-type": "text/html" }).end("<p>Done. Return to PizzaPi and choose Retry.</p>");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" }).end(
    `<h1>Local elicitation fixture</h1><p>No real credentials. Click to finish the out-of-band step.</p><a href="/complete?flow=${encodeURIComponent(id)}">Complete</a>`,
  );
});
const ready = new Promise(resolve => http.listen(port, "127.0.0.1", () => resolve(http.address().port)));

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function respond(id, result) { send({ jsonrpc: "2.0", id, result }); }

async function handle(message) {
  if (message.method === "server/discover") return respond(message.id, { supportedVersions: ["2026-07-28"] });
  if (message.method === "initialize") {
    return respond(message.id, { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "elicitation-url-test", version: "1.0.0" } });
  }
  if (message.method === "tools/list") {
    return respond(message.id, { tools: [{
      name: "connect_account",
      description: "Send the user to a local page via URL elicitation, then wait for them to finish it.",
      inputSchema: { type: "object", properties: { repeatUrl: { type: "boolean", description: "Re-send the URL request (instead of a state-only wait) until the page is completed." } }, additionalProperties: false },
    }] });
  }
  if (message.method === "tools/call") {
    const params = message.params ?? {};
    const caps = params._meta?.["io.modelcontextprotocol/clientCapabilities"]?.elicitation;
    if (!caps?.url) return respond(message.id, { content: [{ type: "text", text: "Client did not advertise URL elicitation." }], isError: true });
    let state = params.requestState;
    if (state === undefined) {
      state = randomUUID();
      flows.set(state, { done: false, consented: false });
    } else if (typeof state !== "string" || !flows.has(state)) {
      return send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown or invalid requestState" } });
    }
    const flow = flows.get(state);
    const response = params.inputResponses?.connect;
    if (response && response.action !== "accept") {
      flows.delete(state);
      return respond(message.id, { content: [{ type: "text", text: `Elicitation ${response.action}; account not connected.` }] });
    }
    if (flow.done) {
      flows.delete(state);
      return respond(message.id, { content: [{ type: "text", text: "Account connected. Out-of-band step completed." }] });
    }
    const url = `http://127.0.0.1:${await ready}/connect?flow=${encodeURIComponent(state)}`;
    if (response?.action === "accept") flow.consented = true;
    if (flow.consented && !params.arguments?.repeatUrl) {
      // Consent given but the page is not finished: state-only round, client must offer manual retry.
      return respond(message.id, { resultType: "input_required", requestState: state });
    }
    return respond(message.id, {
      resultType: "input_required",
      requestState: state,
      inputRequests: { connect: { method: "elicitation/create", params: { mode: "url", url, message: "Finish connecting your account on the local fixture page (no real credentials)." } } },
    });
  }
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
}

process.stdin.setEncoding("utf8");
process.stdin.on("end", () => { http.close(); process.exit(0); });
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)).catch(error => process.stderr.write(`${error}\n`)); }
    catch (error) { process.stderr.write(`${error}\n`); }
  }
});
