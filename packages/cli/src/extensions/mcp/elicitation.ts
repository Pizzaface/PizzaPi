import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ElicitRequestFormParamsSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { ApprovalRequest, ApprovalDecision, ApprovalField } from "@pizzapi/protocol";
import { getApprovalHandler } from "../remote-approval.js";
import { isRecord, type McpElicitationHandler } from "./types.js";

type Prompt = (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>;
type Result = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

// ponytail: generous cap for long OAuth/state URLs; browsers and most servers accept this.
const MAX_URL_LENGTH = 8192;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Spec "Safe URL Handling": https everywhere, plain http only for local
 * development, no embedded credentials, no control characters, punycode flagged.
 */
export function validateElicitationUrl(raw: unknown): { url: URL; warnings: string[] } {
  if (typeof raw !== "string" || raw.length === 0) throw new Error("URL elicitation requires a url string");
  if (raw.length > MAX_URL_LENGTH) throw new Error(`URL elicitation url exceeds ${MAX_URL_LENGTH} characters`);
  // Control/whitespace, bidi overrides and backslashes all enable visual spoofing.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\\]/u.test(raw)) throw new Error("URL elicitation url contains control, whitespace, bidi or backslash characters");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("URL elicitation url is not a valid absolute URL"); }
  // url.href (ASCII host, percent-encoded path) is what gets displayed and opened.
  if (url.username || url.password) throw new Error("URL elicitation url must not embed credentials");
  const local = LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error(`URL elicitation only allows https (or http to localhost), got ${url.protocol}`);
  }
  const warnings: string[] = [];
  if (url.protocol === "http:") warnings.push("Unencrypted http link (allowed only for local development).");
  if (url.hostname.split(".").some(label => label.startsWith("xn--"))) warnings.push("Hostname uses Punycode (xn--) and may imitate another site. Check it carefully.");
  return { url, warnings };
}

function infoFields(server: string, message: string, url: URL, warnings: string[]): ApprovalField[] {
  return [
    { key: "mcp:message", label: "Why the server asks", value: stripVTControlCharacters(message) },
    { key: "mcp:host", label: "Site you would visit", value: url.hostname },
    { key: "mcp:url", label: "Full URL (review before opening)", value: url.href },
    ...warnings.map((warning, i) => ({ key: `mcp:warning:${i}`, label: "Warning", value: warning })),
    { key: "mcp:privacy", label: "Before opening", value: `Only open this if you trust "${stripVTControlCharacters(server)}" and the site above. Anything you enter there goes to that site, not to this assistant. Nothing is fetched or opened until you choose to.` },
  ];
}

/**
 * URL mode: show identity + full URL, get explicit consent, never fetch.
 * `accept` means consent, not completion; a repeat of the same URL in one tool
 * call offers Retry/Open again instead of silently re-consenting.
 */
export async function elicitUrl(server: string, raw: Record<string, unknown>, prompt: Prompt, signal: AbortSignal | undefined, consented: Set<string>): Promise<Result> {
  signal?.throwIfAborted();
  if (typeof raw.message !== "string") throw new Error(`MCP server "${server}": URL elicitation requires a message`);
  const { url, warnings } = validateElicitationUrl(raw.url);
  const title = `MCP server: ${stripVTControlCharacters(server)}`;
  const fields = infoFields(server, raw.message, url, warnings);
  const again = consented.has(url.href);
  const accepts = again ? ["approve", "open"] : ["open"];
  const decision = await prompt({
    title,
    icon: "external-link",
    fields: again
      ? [{ key: "mcp:status", label: "Status", value: "You already opened this link. Finish the steps in your browser, then choose Retry. Nothing is sent to the site by this assistant." }, ...fields]
      : fields,
    actions: again
      ? [
          { id: "approve", label: "Retry", style: "primary" },
          { id: "open", label: "Open again", href: url.href },
          { id: "decline", label: "Decline", style: "danger" },
          { id: "cancel", label: "Cancel" },
        ]
      : [
          { id: "open", label: "Open in browser", style: "primary", href: url.href },
          { id: "decline", label: "Decline", style: "danger" },
          { id: "cancel", label: "Cancel" },
        ],
  }, signal);
  signal?.throwIfAborted();
  // Only the actions offered on this card count as consent.
  if (accepts.includes(decision.action)) {
    consented.add(url.href);
    return { action: "accept" };
  }
  return { action: decision.action === "decline" ? "decline" : "cancel" };
}

/** A state-only MRTR round: the server waits on something out of band. Ask, never spin. */
async function resumePrompt(server: string, prompt: Prompt, signal?: AbortSignal): Promise<"retry" | "cancel"> {
  signal?.throwIfAborted();
  const decision = await prompt({
    title: `MCP server: ${stripVTControlCharacters(server)}`,
    icon: "hourglass",
    fields: [{ key: "mcp:status", label: "Waiting", value: "The server is waiting for a step outside this app (for example a browser flow) to finish. Complete it, then choose Retry, or Cancel the tool call." }],
    actions: [
      { id: "approve", label: "Retry", style: "primary" },
      { id: "cancel", label: "Cancel", style: "danger" },
    ],
  }, signal);
  signal?.throwIfAborted();
  return decision.action === "approve" ? "retry" : "cancel";
}

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
    throw new Error(`MCP server "${server}": unsupported elicitation mode`);
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

/**
 * Web workers use the existing approval bridge; real terminals get a review/edit
 * loop. The TUI never opens links itself: the user copies the shown URL.
 * Headless (no surface) returns undefined, so no elicitation capability is
 * advertised and nothing is ever auto-consented.
 */
export function createElicitationHandler(server: string, ctx?: ExtensionContext): McpElicitationHandler | undefined {
  const web = getApprovalHandler();
  const tui = ctx?.hasUI && ctx.mode === "tui";
  if (!web && !tui) return undefined;
  const prompt: Prompt = tui ? async (request, signal) => {
    const fields = (request.fields ?? []).map(field => ({ ...field }));
    const actions = request.actions ?? [{ id: "approve", label: "Accept" }, { id: "decline", label: "Decline" }, { id: "cancel", label: "Cancel" }];
    const manual = actions.some(a => a.href);
    // Display labels: link actions cannot navigate from a terminal.
    const options = actions.map(a => ({ id: a.id, label: a.href ? `${a.label} (I opened the URL myself)` : a.label }));
    const editable = fields.some(f => f.editable);
    while (true) {
      signal?.throwIfAborted();
      const review = stripVTControlCharacters(fields.map(f => `${f.label}: ${f.value}`).join("\n\n"));
      const note = manual ? "\n\nThis terminal will not open links. Copy the full URL above into your browser yourself." : "";
      const labels = [...options.map(o => o.label), ...(editable ? ["Edit responses"] : [])];
      const action = await ctx.ui.select(`${request.title}\n\n${review}${note}`, labels, { signal });
      if (action !== "Edit responses") {
        const id = options.find(o => o.label === action)?.id ?? "cancel";
        return {
          action: id,
          approved: id === "approve",
          edits: Object.fromEntries(fields.filter(f => f.editable).map(f => [f.key, f.value])),
        };
      }
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
  const consented = new Set<string>();
  const handler: McpElicitationHandler = (params: unknown, signal?: AbortSignal) =>
    isRecord(params) && params.mode === "url"
      ? elicitUrl(server, params, prompt, signal, consented)
      : elicitForm(server, params, prompt, signal);
  handler.resume = signal => resumePrompt(server, prompt, signal);
  return handler;
}
