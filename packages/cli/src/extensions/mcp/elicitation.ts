import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ElicitRequestFormParamsSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { ApprovalRequest, ApprovalDecision, ApprovalField } from "@pizzapi/protocol";
import { getApprovalHandler } from "../remote-approval.js";
import { isRecord } from "./types.js";

type Prompt = (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>;
type Result = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

// The SDK strips unknown schema keywords. Reject them rather than silently
// accepting answers against a weaker schema (or compiling untrusted $refs).
function rejectStrippedKeys(raw: unknown, parsed: unknown): void {
  if (!raw || typeof raw !== "object" || !parsed || typeof parsed !== "object") return;
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(parsed, key)) throw new Error(`Unsupported MCP form schema keyword: ${key}`);
    rejectStrippedKeys(Reflect.get(raw, key), Reflect.get(parsed, key));
  }
}

/** Reuse the editable approval card; never send intermediate answers to the model. */
export async function elicitForm(server: string, raw: unknown, prompt: Prompt, signal?: AbortSignal): Promise<Result> {
  signal?.throwIfAborted();
  if (!isRecord(raw) || (raw.mode !== undefined && raw.mode !== "form")) {
    throw new Error(`MCP server "${server}": only form elicitation is supported`);
  }
  const parsed = ElicitRequestFormParamsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`MCP server "${server}": invalid form elicitation schema`);
  const { message, requestedSchema: schema } = parsed.data;
  rejectStrippedKeys(raw.requestedSchema, schema);
  const validate = new AjvJsonSchemaValidator().getValidator<Record<string, unknown>>(schema);
  const required = new Set(schema.required ?? []);
  if ([...required].some(key => !Object.hasOwn(schema.properties, key))) throw new Error("MCP form requires an unknown property");
  const fields: ApprovalField[] = Object.entries(schema.properties).map(([key, property]) => ({
    key,
    // Show the restricted schema as guidance, including enum titles and bounds.
    label: stripVTControlCharacters(`${property.title ?? key}${required.has(key) ? " (required)" : " (optional; blank omits)"} — ${JSON.stringify(property)}`),
    value: property.default === undefined ? "" : typeof property.default === "string" ? property.default : JSON.stringify(property.default),
    editable: true,
  }));
  const infoKey = (suffix: string) => {
    let key = `mcp:${suffix}`;
    while (Object.hasOwn(schema.properties, key)) key += ":";
    return key;
  };
  let error: string | undefined;
  while (true) {
    signal?.throwIfAborted();
    const decision = await prompt({
      title: `MCP server: ${stripVTControlCharacters(server)}`,
      // Plain fields, not Markdown: server-supplied links must not be clickable.
      fields: [
        { key: infoKey("message"), label: "Information requested", value: stripVTControlCharacters(message) },
        { key: infoKey("privacy"), label: "Before sharing", value: "Do not enter passwords, API keys, tokens or payment credentials. Numbers and booleans use JSON values; multi-select uses a JSON array of enum values. Review your answers before Accept." },
        ...(error ? [{ key: infoKey("error"), label: "Validation error", value: error }] : []),
        ...fields,
      ],
      actions: [
        { id: "approve", label: "Accept", style: "primary" },
        { id: "decline", label: "Decline", style: "danger" },
        { id: "cancel", label: "Cancel" },
      ],
    }, signal);
    signal?.throwIfAborted();
    if (decision.action !== "approve") return { action: decision.action === "decline" ? "decline" : "cancel" };
    // Only declared fields are eligible for transmission; edits are untrusted.
    for (const field of fields) {
      if (decision.edits && Object.hasOwn(decision.edits, field.key) && typeof decision.edits[field.key] === "string") field.value = decision.edits[field.key];
    }
    const entries: [string, unknown][] = [];
    error = undefined;
    for (const field of fields) {
      const property = schema.properties[field.key];
      if (field.value === "" && !required.has(field.key)) continue;
      try {
        entries.push([field.key, property.type === "string" ? field.value : JSON.parse(field.value)]);
      } catch {
        error = `${field.key}: enter a JSON ${property.type} value`;
        break;
      }
    }
    if (error) continue;
    const result = validate(Object.fromEntries(entries));
    if (result.valid) return { action: "accept", content: result.data };
    error = result.errorMessage;
  }
}

/** Web workers use the existing approval bridge; real terminals get a review/edit loop. */
export function createElicitationHandler(server: string, ctx?: ExtensionContext) {
  const web = getApprovalHandler();
  const tui = ctx?.hasUI && ctx.mode === "tui";
  if (!web && !tui) return undefined;
  const prompt: Prompt = tui ? async (request, signal) => {
    const fields = (request.fields ?? []).map(field => ({ ...field }));
    while (true) {
      signal?.throwIfAborted();
      const review = stripVTControlCharacters(fields.map(f => `${f.label}: ${f.value}`).join("\n\n"));
      const action = await ctx.ui.select(`${request.title}\n\n${review}`, ["Accept", "Edit responses", "Decline", "Cancel"], { signal });
      if (action !== "Edit responses") return {
        action: action === "Accept" ? "approve" : action === "Decline" ? "decline" : "cancel",
        approved: action === "Accept",
        edits: Object.fromEntries(fields.filter(f => f.editable).map(f => [f.key, f.value])),
      };
      for (const field of fields.filter(f => f.editable)) {
        const choice = await ctx.ui.select(stripVTControlCharacters(`${request.title}\n${field.label}\nCurrent: ${field.value}`), ["Keep", "Change", "Decline", "Cancel"], { signal });
        if (choice === "Keep") continue;
        if (choice !== "Change") return { action: choice === "Decline" ? "decline" : "cancel", approved: false };
        const value = await ctx.ui.input(`${request.title}\n${field.label}`, field.value, { signal });
        if (value === undefined) return { action: "cancel", approved: false };
        field.value = value;
      }
    }
  } : web!;
  return (params: unknown, signal?: AbortSignal) => elicitForm(server, params, prompt, signal);
}
