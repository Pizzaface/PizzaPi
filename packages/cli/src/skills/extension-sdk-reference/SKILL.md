---
name: extension-sdk-reference
description: Comprehensive reference for authoring pi extensions and PizzaPi packages. Covers the pi core extension API (events, UI, tools, commands, models), PizzaPi host detection, service messaging, approvals, runner services (panels, triggers, sigils), and the complete authoring workflows.
---

# Extension SDK Reference

The **extension SDK** is divided into two layers: the **pi core** (`@earendil-works/pi-coding-agent`) and **PizzaPi-specific** capabilities (`@pizzapi/extension-sdk`). This skill covers both, their interaction model, and how to ship runner services.

## Mental Model

```
Extension (Session-side code)
  ├─ subscribes to pi events (session_start, tool_call, etc.)
  ├─ registers tools, commands, shortcuts
  ├─ requests user approval via UI
  ├─ sends messages to agent
  └─ detects PizzaPi host & sends service messages

    ↓↓↓ (via event bus + relay socket)

Runner Service (Daemon-side code)
  ├─ listens for service messages from sessions
  ├─ exposes HTTP panel (iframe)
  ├─ broadcasts triggers (fire events into agent sessions)
  └─ resolves sigils ([[type:id]] tokens)
```

---

## Part 1: Pi Core Extension API

### Entry point: Extension factory

Every extension is a **TypeScript module** that default-exports an async factory function:

```typescript
// extensions/my-extension.ts
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const myExtension: ExtensionFactory = (pi) => {
  // One-time setup here.
  // `pi` is the ExtensionAPI, valid for the entire session lifetime.
  // (Or until /reload or session switch.)

  pi.on("session_start", (event, ctx) => {
    // Handler runs every time a session starts
  });

  return {
    dispose: () => {
      // Optional cleanup on extension unload (/reload, session end)
    },
  };
};

export default myExtension;
```

The factory runs synchronously during extension load. Async setup (e.g. HTTP server startup) is safe — it queues without blocking.

### Event subscriptions

```typescript
pi.on(eventType, handler);
```

#### Session lifecycle events

```typescript
pi.on("session_start", (event, ctx) => {
  // event.reason: "startup" | "reload" | "new" | "resume" | "fork"
  // Fire once per session load, or when reloading extensions.
});

pi.on("session_info_changed", (event, ctx) => {
  // event.name: session display name (may be undefined if cleared)
});

pi.on("session_before_switch", (event, ctx) => {
  // event.reason: "new" | "resume"
  // event.targetSessionFile?: string
  // Return { cancel: true } to block the switch.
});

pi.on("session_before_fork", (event, ctx) => {
  // event.entryId, event.position: "before" | "at"
  // Return { cancel: true } to block forking.
});

pi.on("session_shutdown", (event, ctx) => {
  // Cleanup before session replacement or quit.
  // event.reason: "quit" | "reload" | "new" | "resume" | "fork"
});
```

#### LLM & agent loop events

```typescript
pi.on("before_agent_start", (event, ctx) => {
  // event.prompt: expanded user text
  // event.systemPrompt: full system prompt string
  // event.images?: ImageContent[] (attached images)
  // event.systemPromptOptions: structured options used to build the prompt
  // Modify systemPrompt or return { systemPrompt: "..." } to replace it.
  // Return { message: ... } to inject a custom message before the turn.
});

pi.on("agent_start", (event, ctx) => {
  // Agent loop started, before any tool execution.
});

pi.on("agent_end", (event, ctx) => {
  // Agent loop finished (all turns, compaction, retries done).
  // event.messages: this run's messages only (not full transcript).
});

pi.on("agent_settled", (event, ctx) => {
  // Final settlement: no automatic retry, compaction, or queued continuation will run.
  // Use this instead of agent_end for true session completion.
});

pi.on("turn_start", (event, ctx) => {
  // event.turnIndex, event.timestamp
});

pi.on("turn_end", (event, ctx) => {
  // event.turnIndex, event.message, event.toolResults[]
});

pi.on("message_start", (event, ctx) => {
  // event.message: AgentMessage (user, assistant, or tool_result)
});

pi.on("message_update", (event, ctx) => {
  // Streaming update during assistant response.
  // event.assistantMessageEvent: raw token/delta
});

pi.on("message_end", (event, ctx) => {
  // Message finalized (may have been modified by handlers).
  // Return { message: ... } to replace the message.
});
```

#### Tool execution events

```typescript
pi.on("tool_call", (event, ctx) => {
  // Before a tool executes.
  // event.toolName: "bash" | "read" | "edit" | "write" | ... | custom name
  // event.input: tool arguments (mutable in place)
  // event.toolCallId: unique identifier for this execution
  // Use isToolCallEventType(name, event) to narrow by tool.
  // Return { block: true, reason: "..." } to prevent execution.
  // Mutating event.input patches the call arguments.
});

pi.on("tool_result", (event, ctx) => {
  // After tool execution, before the result is consumed by the LLM.
  // event.toolName, event.input, event.content[]
  // event.isError: boolean
  // event.details?: tool-specific structured data
  // Return { content: [...], details: ..., isError: bool } to modify.
});

pi.on("tool_execution_start", (event, ctx) => {
  // Emitted when tool starts.
  // event.toolCallId, event.toolName, event.args
});

pi.on("tool_execution_update", (event, ctx) => {
  // Streaming/partial output from a running tool.
  // event.partialResult
});

pi.on("tool_execution_end", (event, ctx) => {
  // Tool finished.
  // event.result, event.isError
});
```

#### Model & thinking events

```typescript
pi.on("model_select", (event, ctx) => {
  // event.model: selected Model
  // event.previousModel?: Model
  // event.source: "set" | "cycle" | "restore"
});

pi.on("thinking_level_select", (event, ctx) => {
  // event.level: ThinkingLevel
  // event.previousLevel: ThinkingLevel
});
```

#### User input events

```typescript
pi.on("user_bash", (event, ctx) => {
  // User ran a bash command via ! or !! prefix.
  // event.command: string
  // event.excludeFromContext: true if !! was used (not sent to LLM)
  // Return { operations: customBashOps } or { result: bashResult } to override.
});

pi.on("input", (event, ctx) => {
  // User input received, before agent processing.
  // event.text, event.images?, event.source: "interactive" | "rpc" | "extension"
  // event.streamingBehavior?: "steer" | "followUp" (how it queues if agent is running)
  // Return { action: "continue" } (default)
  //     or { action: "transform", text: "...", images?: [...] } (modify)
  //     or { action: "handled" } (extension handled it, no agent turn)
});
```

#### Provider & context events

```typescript
pi.on("context", (event, ctx) => {
  // Before each LLM call.
  // event.messages: full message array (mutable)
  // Return { messages: [...] } to replace.
});

pi.on("before_provider_request", (event, ctx) => {
  // Before provider HTTP call.
  // event.payload: request body (mutable)
  // Return the payload to replace it.
});

pi.on("before_provider_headers", (event, ctx) => {
  // After headers assembled, before provider call.
  // event.headers: Record<string, string> (mutable in place)
  // Mutation is permanent; return value ignored.
  // Use null as a value to delete a header.
});

pi.on("after_provider_response", (event, ctx) => {
  // After provider response received.
  // event.status: HTTP status
  // event.headers: response headers
});
```

#### Context compaction

```typescript
pi.on("session_before_compact", (event, ctx) => {
  // Before compaction (context pruning).
  // event.preparation: compaction metadata
  // event.reason: "manual" | "threshold" | "overflow"
  // event.willRetry: true if the aborted turn will retry after compaction
  // event.signal: AbortSignal for cancellation
  // Return { cancel: true } to prevent, or { compaction: result } to substitute.
});

pi.on("session_compact", (event, ctx) => {
  // After compaction.
  // event.compactionEntry: created CompactionEntry
  // event.fromExtension: true if extension substituted the compaction
  // event.reason, event.willRetry
});
```

#### Session tree navigation

```typescript
pi.on("session_before_tree", (event, ctx) => {
  // Before navigating to a different point in the session tree.
  // event.preparation: TreePreparation (target, entries to summarize, etc.)
  // event.signal: AbortSignal
  // Return { cancel: true } to prevent, or { summary: {...} } to provide custom summarization.
});

pi.on("session_tree", (event, ctx) => {
  // After tree navigation.
  // event.newLeafId, event.oldLeafId
  // event.summaryEntry?: custom summary that was inserted
});
```

#### Resource discovery

```typescript
pi.on("resources_discover", (event, ctx) => {
  // event.cwd: current working directory
  // event.reason: "startup" | "reload"
  // Return { skillPaths, promptPaths, themePaths } to contribute resources.
  // Paths can be absolute or relative to the project/home.
});
```

#### Trust & security

```typescript
pi.on("project_trust", async (event, ctx) => {
  // Fired when a project requests trust (if project-local extensions / configs exist).
  // event.cwd: directory in question
  // ctx.ui: limited UI (select, confirm, input, notify)
  // Return { trusted: "yes" | "no" | "undecided", remember?: boolean }
});
```

### Context API

Every handler receives `ctx`, the `ExtensionContext`:

```typescript
interface ExtensionContext {
  ui: ExtensionUIContext;        // Dialogs, notifications, custom components
  mode: ExtensionMode;           // "tui" | "rpc" | "json" | "print"
  hasUI: boolean;                // Can show dialogs?
  cwd: string;                   // Current working directory
  sessionManager: ReadonlySessionManager;
  modelRegistry: ModelRegistry;
  model: Model<any> | undefined;
  thinkingLevel?: ThinkingLevel;

  isIdle(): boolean;             // Agent not streaming
  isProjectTrusted(): boolean;   // Project-local trust active
  signal: AbortSignal | undefined; // Abort signal when agent is streaming
  abort(): void;                 // Abort current agent operation
  hasPendingMessages(): boolean; // Queued messages waiting
  shutdown(): void;              // Gracefully exit pi
  getContextUsage(): ContextUsage | undefined;
  compact(options?: CompactOptions): void; // Trigger compaction
  getSystemPrompt(): string;     // Current effective system prompt
}
```

**Command context** extends this with session control:

```typescript
interface ExtensionCommandContext extends ExtensionContext {
  getSystemPromptOptions(): BuildSystemPromptOptions;
  waitForIdle(): Promise<void>;
  newSession(options?: { ... }): Promise<{ cancelled: boolean }>;
  fork(entryId: string, options?: { ... }): Promise<{ cancelled: boolean }>;
  navigateTree(targetId: string, options?: { ... }): Promise<{ cancelled: boolean }>;
  switchSession(sessionPath: string, options?: { ... }): Promise<{ cancelled: boolean }>;
  reload(): Promise<void>;
}
```

### UI API

```typescript
ctx.ui.select(title: string, options: string[], opts?: UIDialogOptions): Promise<string | undefined>
ctx.ui.confirm(title: string, message: string, opts?: UIDialogOptions): Promise<boolean>
ctx.ui.input(title: string, placeholder?: string, opts?: UIDialogOptions): Promise<string | undefined>
ctx.ui.notify(message: string, type?: "info" | "warning" | "error"): void

// Status bar
ctx.ui.setStatus(key: string, text: string | undefined): void

// Working/loading message (during streaming)
ctx.ui.setWorkingMessage(message?: string): void
ctx.ui.setWorkingVisible(visible: boolean): void
ctx.ui.setWorkingIndicator(options?: WorkingIndicatorOptions): void
ctx.ui.setHiddenThinkingLabel(label?: string): void

// Widgets (above/below editor)
ctx.ui.setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void
ctx.ui.setWidget(key: string, factory?: (tui, theme) => Component, options?: ExtensionWidgetOptions): void

// Custom components
ctx.ui.setHeader(factory?: (tui, theme) => Component): void
ctx.ui.setFooter(factory?: (tui, theme, footerData) => Component): void
ctx.ui.custom<T>(factory, options?): Promise<T>

// Editor
ctx.ui.pasteToEditor(text: string): void
ctx.ui.setEditorText(text: string): void
ctx.ui.getEditorText(): string
ctx.ui.editor(title: string, prefill?: string): Promise<string | undefined>
ctx.ui.setEditorComponent(factory?: EditorFactory): void
ctx.ui.getEditorComponent(): EditorFactory | undefined

// Autocomplete
ctx.ui.addAutocompleteProvider(factory: AutocompleteProviderFactory): void

// Themes
ctx.ui.theme: Theme (current theme)
ctx.ui.getAllThemes(): { name: string; path?: string }[]
ctx.ui.getTheme(name: string): Theme | undefined
ctx.ui.setTheme(theme: string | Theme): { success: boolean; error?: string }

// Tool expansion
ctx.ui.getToolsExpanded(): boolean
ctx.ui.setToolsExpanded(expanded: boolean): void

// Terminal input (TUI mode only)
ctx.ui.onTerminalInput(handler: TerminalInputHandler): () => void
```

UIDialogOptions:
```typescript
{
  signal?: AbortSignal;    // Programmatic dismissal
  timeout?: number;        // Auto-dismiss in ms with countdown
}
```

### Tool registration

```typescript
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type as T } from "typebox";

pi.registerTool(defineTool({
  name: "send-email",
  label: "Send Email",
  description: "Send an email to a recipient",

  // TypeBox schema for parameters (used by LLM and validation)
  parameters: T.Object({
    to: T.String({ description: "Email address" }),
    subject: T.String(),
    body: T.String(),
  }),

  // Optional: LLM constrained sampling configuration
  constrainedSampling: false, // or a ConstrainedSamplingConfig

  // Optional: One-line snippet for system prompt Available tools section
  promptSnippet: "send-email(to, subject, body)",

  // Optional: Guidelines appended to system prompt Guidelines section
  promptGuidelines: [
    "Only send emails after user confirmation",
    "Always include an unsubscribe link",
  ],

  // Optional: Execution mode (if different from default)
  executionMode: "sequential", // or "parallel"

  // Optional: Prepare raw arguments before schema validation
  prepareArguments: (args) => ({
    to: args.recipient || args.to,
    subject: args.title || args.subject,
    body: args.message || args.body,
  }),

  // Execution handler
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // toolCallId: unique identifier for this execution
    // signal: AbortSignal (can be undefined if not streaming)
    // onUpdate?: callback for streaming updates
    // ctx: ExtensionContext
    // Return AgentToolResult<TDetails>

    try {
      const result = await sendEmail(params.to, params.subject, params.body);
      return {
        // content: rendered output (TextContent | ImageContent)[]
        content: [{ type: "text", text: `Email sent to ${params.to}` }],
        // details: tool-specific structured data (optional)
        details: { messageId: result.id, timestamp: Date.now() },
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        error: true,
      };
    }
  },

  // Optional: Custom rendering for tool call display
  renderCall: (args, theme, context) => {
    return createComponent(`Sending email to ${args.to}...`);
  },

  // Optional: Custom rendering for tool result display
  renderResult: (result, options, theme, context) => {
    if (result.error) return createComponent("❌ Failed");
    return createComponent(`✓ Sent to ${result.details.to}`);
  },
}));
```

### Command registration

```typescript
pi.registerCommand("send-email", {
  description: "Send an email interactively",

  // Optional: provide completion suggestions for the command's arguments
  getArgumentCompletions: async (argumentPrefix) => {
    return [
      { label: "alice@example.com", filterText: "alice" },
      { label: "bob@example.com", filterText: "bob" },
    ];
  },

  // Command handler (receives ExtensionCommandContext)
  async handler(args, ctx) {
    // args: unparsed argument string after the command name
    const to = await ctx.ui.input("To:", "user@example.com");
    if (!to) return;
    const subject = await ctx.ui.input("Subject:");
    if (!subject) return;
    const body = await ctx.ui.editor("Email body:");
    if (body === undefined) return;

    // Commands have access to session control:
    await ctx.sendUserMessage(`Send email to ${to} with subject "${subject}"`);
  },
});

// Later, user types: /send-email
// The handler is invoked with empty args.
```

### Keyboard shortcuts

```typescript
pi.registerShortcut("ctrl+shift+e", {
  description: "Insert email template",
  async handler(ctx) {
    ctx.ui.pasteToEditor("To: \nSubject: \nBody: ");
  },
});

// Registered keybindings appear in the help menu (ctrl+?)
// and can be overridden per-mode via config
```

### CLI flags

```typescript
pi.registerFlag("email-provider", {
  description: "Email service provider (smtp, sendgrid, mailgun)",
  type: "string",
  default: "smtp",
});

const provider = pi.getFlag("email-provider") as string;
```

Flags are set in `.pizzapi/config.json`:
```json
{
  "flags": {
    "email-provider": "sendgrid"
  }
}
```

### Message sending

```typescript
// Send a custom message (not sent to LLM, persists in session)
pi.sendMessage({
  customType: "email_log",
  content: [{ type: "text", text: "Email sent" }],
  display: { title: "Email", icon: "mail" },
  details: { to: "alice@example.com", status: "sent" },
}, {
  triggerTurn: false,           // Don't auto-trigger agent
  deliverAs: "steer" | "followUp", // How to queue if agent is running
});

// Send a user message (sent to LLM, triggers a turn)
await pi.sendUserMessage("Please send an email to alice@example.com", {
  deliverAs: "steer" | "followUp",
});
```

### Model provider registration

```typescript
// Register a new provider with custom models
pi.registerProvider("my-proxy", {
  baseUrl: "https://proxy.example.com",
  apiKey: "$MY_API_KEY",  // env interpolation
  api: "anthropic-messages",
  models: [
    {
      id: "claude-sonnet-4-20250514",
      name: "Claude Sonnet (proxy)",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    },
  ],
});

// Override baseUrl for existing provider
pi.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com",
});

// Register provider with OAuth
pi.registerProvider("corp-ai", {
  baseUrl: "https://ai.corp.com",
  api: "openai-responses",
  models: [...],
  oauth: {
    name: "Corporate AI (SSO)",
    async login(callbacks) {
      // Initiate OAuth flow, return credentials
      return { access_token: "...", refresh_token: "..." };
    },
    async refreshToken(credentials) {
      // Refresh expired token
      return { access_token: "...", refresh_token: "..." };
    },
    getApiKey(credentials) {
      return credentials.access_token;
    },
  },
});

// Unregister a provider (restores built-in models if overridden)
pi.unregisterProvider("my-proxy");
```

### Custom message & entry renderers

```typescript
pi.registerMessageRenderer<{ status: string }>("email_log", (msg, options, theme) => {
  return createComponent(`
    <div style="padding: 8px; border: 1px solid ${theme.color}">
      ${msg.content.map(c => c.text).join("")}
      Status: ${msg.details?.status}
    </div>
  `);
});

// Custom entries (do not participate in LLM context)
pi.registerEntryRenderer<{ itemId: string }>("bookmark", (entry, options, theme) => {
  return createComponent(`📌 Bookmark: ${entry.details?.itemId}`);
});
```

### Event bus

Extensions can emit & listen to custom events:

```typescript
pi.events.on("my-event", (payload) => {
  console.log("Custom event:", payload);
});

pi.events.emit("my-event", { data: "value" });
```

---

## Part 2: PizzaPi Extension SDK

These functions are only available when running on a PizzaPi host. They bridge session-side code to daemon-side services.

### Host detection

```typescript
import { detectPizzaPiHost, onPizzaPiHost, isPizzaPiHostInfo } from "@pizzapi/extension-sdk";

// Synchronous probe (may return undefined if host not ready yet)
const host = detectPizzaPiHost(pi.events);
if (host?.capabilities.includes("services")) {
  // Safe to use runner services, triggers, sigils
}

// Async wait for host readiness
const unsubscribe = onPizzaPiHost(pi.events, (host) => {
  // Host is ready; capabilities guaranteed to be populated
  console.log("PizzaPi host ready with capabilities:", host.capabilities);
});

// Later, unsubscribe if needed
unsubscribe();
```

`PizzaPiHostInfo`:
```typescript
{
  apiVersion: 1,
  capabilities: string[]; // e.g. ["services", "agents", "rules", "mcp", "panels", "triggers", "sigils", "serviceMessages"]
}
```

### Service messaging (outbound)

Send events from a session-side extension to a daemon-side service:

```typescript
import { sendServiceMessage } from "@pizzapi/extension-sdk";

// When something noteworthy happens in the session (user action, tool result, etc.),
// forward it to the service
pi.on("message_end", (event, ctx) => {
  sendServiceMessage(pi.events, "discord", "message_sent", {
    content: event.message.content,
    timestamp: Date.now(),
  });
});
```

The host stamps a unique top-level `id` for dedupe (`env.id`), and the relay stamps the top-level `sessionId` from the authenticated socket. The message is fire-and-forget — no response expected.

Use case: Discord bridge, Slack connector, email notifications, webhook integrations.

### Approval requests

Block a tool until the user approves an action:

```typescript
import { requestApproval } from "@pizzapi/extension-sdk";

pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "send-email") return;

  const decision = await requestApproval(pi.events, {
    title: "Send Email",
    description: `Send email to: ${event.input.to}`,
    fields: [
      { name: "To", value: event.input.to },
      { name: "Subject", value: event.input.subject },
    ],
  });

  if (!decision.approved && !decision.unavailable) {
    return { block: true, reason: "User rejected" };
  }
  // unavailable: true means no web UI to show the approval (headless/disconnected)
  // Decide: fail safely (block) or allow (continue)
});
```

`ApprovalRequest`:
```typescript
{
  title: string;                    // Dialog title
  description?: string;             // Explanation
  fields?: ApprovalField[];         // Key-value pairs to display
  actions?: ApprovalAction[];       // Custom action buttons (approve/reject/custom)
}

type ApprovalField = {
  name: string;
  value: string;
};

type ApprovalAction = "approve" | "reject" | string;  // Custom action names
```

`ApprovalDecision`:
```typescript
{
  action: string;               // Which button user clicked (usually "approve" or "reject")
  approved: boolean;            // true if action === "approve"
  unavailable?: boolean;        // true if no UI could render (headless, disconnected)
}
```

---

## Part 3: Runner Services

A **runner service** is a daemon-side process that ships inside a pi package. It exposes UI panels, fires triggers (events into agent sessions), and resolves sigils (`[[type:id]]` tokens).

### Package structure

```
my-service/
  package.json              # pi.pizzapi overlay + service declaration
  service/
    index.ts                # ServiceHandler (default export)
    panel/
      index.html            # Iframe HTML/CSS/JS (optional)
    triggers.json           # Trigger definitions (optional)
    sigils.json             # Sigil definitions (optional)
```

### Package declaration

**package.json:**

```json
{
  "name": "@me/my-service",
  "type": "module",
  "pi": {
    "pizzapi": {
      "schemaVersion": 1,
      "services": [
        {
          "id": "my-service",
          "label": "My Service",
          "icon": "activity",
          "entry": "./service/index.ts",
          "panel": { "dir": "./service/panel" },
          "triggers": [
            {
              "type": "my-service:event_happened",
              "label": "Event Happened",
              "description": "Emitted when something noteworthy occurs",
              "schema": {
                "type": "object",
                "properties": {
                  "event_id": { "type": "string" },
                  "timestamp": { "type": "number" }
                }
              }
            }
          ],
          "sigils": [
            {
              "type": "my-item",
              "label": "My Item",
              "description": "A thing from my service",
              "icon": "square",
              "resolve": "/api/resolve/item/{id}"
            }
          ]
        }
      ]
    }
  }
}
```

Declaration fields:

| Field | Required | Default | Notes |
|-------|----------|---------|-------|
| `id` | Yes | — | Must match `ServiceHandler.id` and be unique (no collisions with built-in) |
| `label` | Yes | — | Button text in header |
| `icon` | No | `"square"` | Lucide icon name, kebab-case |
| `entry` | No | `"./index.ts"` | Service module path (relative to package root) |
| `panel.dir` | No | — | Panel HTML directory (omit for no panel) |
| `panel.requires` | No | `[]` | Variables to pass to panel as query params: `PWD`, `SESSION_ID`, `HOME`, `USER`, `PROJECT_DIR` |
| `triggers` | No | `[]` | Inline array or path to JSON file |
| `sigils` | No | `[]` | Inline array or path to JSON file |
| `sessionModes` | No | `[]` | Workspace-scoped UI themes (see Session modes section) |

### ServiceHandler implementation

```typescript
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ServiceHandler, ServiceInitOptions, PizzaPiSocket } from "@pizzapi/extension-sdk";
import { fileURLToPath } from "node:url";

class MyService implements ServiceHandler {
  get id() { return "my-service"; }

  #server: ReturnType<typeof Bun.serve> | null = null;

  init(socket: PizzaPiSocket, options: ServiceInitOptions) {
    // Set up HTTP server for panel
    const panelDir = join(dirname(fileURLToPath(import.meta.url)), "panel");
    const indexHtml = readFileSync(join(panelDir, "index.html"), "utf-8");

    this.#server = Bun.serve({
      port: 0, // OS picks free port
      fetch: async (req) => {
        const url = new URL(req.url);
        const cors = { "Access-Control-Allow-Origin": "*" };

        // Panel context: variables from panel.requires arrive as query params
        if (url.pathname.endsWith("/api/data")) {
          const sessionId = url.searchParams.get("sessionId");
          return Response.json({ sessionId }, { headers: cors });
        }

        // Sigil resolution: route must match the "resolve" template
        if (url.pathname.includes("/api/resolve/item/")) {
          const id = url.pathname.split("/").pop();
          return Response.json({
            id,
            title: "Item Name",
            href: "https://example.com/items/" + id,
            subtitle: "View",
          }, { headers: cors });
        }

        // Trigger an event
        if (url.pathname.endsWith("/api/do-thing") && req.method === "POST") {
          await broadcastTrigger(socket, "my-service:event_happened", {
            event_id: "abc123",
            timestamp: Date.now(),
          });
          return Response.json({ ok: true }, { headers: cors });
        }

        return new Response(indexHtml, { headers: { "Content-Type": "text/html" } });
      },
    });

    // Announce the panel port
    options.announcePanel?.(this.#server.port);

    // Listen for service messages from sessions
    socket.on("service_message", (data: any) => {
      if (data.serviceId !== "my-service") return;
      console.log("Received:", data.type, data.payload);
    });
  }

  dispose() {
    this.#server?.stop(true);
    this.#server = null;
  }

  handleSessionEnded?(sessionId: string) {
    // Clean up any per-session state (processes, buffers, temp files)
    console.log("Session ended:", sessionId);
  }

  reconcileSubscriptions?(subscriptions, options) {
    // Rebuild per-subscription state after daemon reconnect (e.g. re-start file watchers)
    return { applied: subscriptions.length };
  }
}

export default new MyService();
```

### Trigger broadcasting

From the service, fire triggers into agent sessions:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function readRunnerId(): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".pizzapi", "runner.json"), "utf-8"));
    return typeof raw?.runnerId === "string" ? raw.runnerId : null;
  } catch { return null; }
}

function getRelayUrl(): string {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".pizzapi", "config.json"), "utf-8"));
    if (typeof cfg?.relayUrl === "string") return cfg.relayUrl;
  } catch {}
  return "http://localhost:7492";
}

function getApiKey(): string | null {
  return process.env.PIZZAPI_RUNNER_API_KEY ?? process.env.PIZZAPI_API_KEY ?? null;
}

async function broadcastTrigger(
  type: string,
  payload: Record<string, unknown>,
  opts?: { deliverAs?: "steer" | "followUp"; summary?: string }
): Promise<void> {
  const runnerId = readRunnerId();
  const apiKey = getApiKey();
  if (!runnerId || !apiKey) return;

  await fetch(`${getRelayUrl()}/api/runners/${runnerId}/trigger-broadcast`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      type,
      payload,
      source: "my-service",
      deliverAs: opts?.deliverAs ?? "followUp",
      summary: opts?.summary,
    }),
  }).catch(err => console.error("Trigger broadcast failed:", err));
}
```

### Sigil resolution

Sigils are `[[type:id]]` tokens rendered as clickable chips by the UI. Define them in the package and resolve IDs via HTTP:

```json
[
  {
    "type": "pr",
    "label": "Pull Request",
    "description": "GitHub PR",
    "icon": "git-pull-request",
    "resolve": "/api/resolve/pr/{id}"
  }
]
```

The service HTTP handler matches the `resolve` path:

```typescript
if (url.pathname.includes("/api/resolve/pr/")) {
  const id = url.pathname.split("/").pop();
  const pr = await fetchPR(id);
  return Response.json({
    id,
    title: pr.title,
    href: pr.url,
    subtitle: `#${id}`,
    image: pr.author.avatar,
  }, { headers: cors });
}
```

### Panel HTML/CSS/JS

Panels render in a sandboxed iframe (280px tall at bottom, 320px wide at side). Keep it self-contained:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { background: #0a0a0b; color: #e4e4e7; font: 11px sans-serif; margin: 0; padding: 8px; }
    .item { padding: 4px; border: 1px solid #27272a; border-radius: 2px; margin-bottom: 4px; }
    .item:hover { background: #18181b; cursor: pointer; }
  </style>
</head>
<body>
  <div id="items"></div>
  <script>
    const p = new URLSearchParams(location.search);
    const sessionId = p.get("sessionId");

    async function load() {
      const res = await fetch(`./api/data?${p.toString()}`);
      const data = await res.json();
      document.getElementById("items").innerHTML = `<div class="item">${data.sessionId}</div>`;
    }

    load();
    setInterval(load, 3000); // Refresh every 3s
  </script>
</body>
</html>
```

**Important:** Panels must include `Access-Control-Allow-Origin: *` in API responses, use relative URLs (`./api/...`), and inline all CSS/JS (no CDN).

### Session modes

A session mode claims a workspace and applies custom UI (label vocabulary, theme, chrome visibility, home suggestions):

```json
{
  "sessionModes": [{
    "id": "work",
    "label": "Work",
    "icon": "briefcase",
    "workspace": "~/Documents/Workspace",
    "ui": {
      "preset": "work",  // "work" hides git/terminal; "coding" shows all
      "chrome": { "git": false, "terminal": true, "processes": false },
      "vocabulary": { "session": "task", "sessions": "tasks" },
      "accent": "#7c3aed",
      "composerPlaceholder": "What do you need done?",
      "home": {
        "greeting": "What are we working on?",
        "suggestions": [
          { "label": "Daily report", "icon": "sun", "prompt": "Write my daily report" }
        ]
      },
      "artifacts": { "enabled": true },
      "scheduled": true
    }
  }]
}
```

### Connectivity bridges (Discord, Slack, etc.)

When sessions need persistent external connections:

**Daemon-side service:** owns the one connection, listens for service messages from sessions.

```typescript
init(socket, options) {
  socket.on("service_message", (data: any) => {
    if (data.type === "discord_post") {
      // Route to Discord channel
      postToDiscord(data.payload.content);
    }
  });
}
```

**Session-side extension:** observes session events and forwards to service.

```typescript
import { sendServiceMessage } from "@pizzapi/extension-sdk";

pi.on("message_end", (event, ctx) => {
  sendServiceMessage(pi.events, "discord", "discord_post", {
    content: event.message.content,
    sessionId: ctx.sessionManager.sessionId,
  });
});
```

**At-least-once delivery:** The relay may emit the same `service_message` envelope twice (local socket + remote mirror). Services must dedupe by `env.id`:

```typescript
const seen = new Set<string>();
const isDuplicate = (id: string) => {
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 500) {
    const first = seen.values().next().value;
    if (first) seen.delete(first);
  }
  return false;
};

socket.on("service_message", (data: any) => {
  if (isDuplicate(data.id)) return; // Already processed
  // ... process message
});
```

### Installation & granting

```bash
# Install and grant daemon-service trust in one step
pizza install ~/my-service --allow-daemon-services

# Or install without grant, then grant later
pizza install ~/my-service --no-allow-daemon-services
pizza config grant ~/my-service

# Revoke specific service
pizza config revoke ~/my-service my-service

# Verify
pizza list  # Check services:[...]
```

Services become active after daemon restart and grant verification.

---

## Part 4: Working Examples

### Example 1: Email tool with approval gate

**Extension (session-side):**

```typescript
import { defineTool, Type as T } from "@earendil-works/pi-coding-agent";
import { requestApproval } from "@pizzapi/extension-sdk";

export default (pi) => {
  pi.registerTool(defineTool({
    name: "send-email",
    label: "Send Email",
    description: "Send an email",
    parameters: T.Object({
      to: T.String({ description: "Recipient email" }),
      subject: T.String(),
      body: T.String(),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Request approval before executing
      const decision = await requestApproval(pi.events, {
        title: "Send Email",
        description: "Approve email before sending",
        fields: [
          { name: "To", value: params.to },
          { name: "Subject", value: params.subject },
        ],
      });

      if (!decision.approved) {
        if (decision.unavailable) {
          return { content: [{ type: "text", text: "No UI available for approval" }], error: true };
        }
        return { content: [{ type: "text", text: "Email rejected by user" }], error: true };
      }

      // Execute email send
      try {
        const result = await fetch("https://api.example.com/send", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.EMAIL_API_KEY}` },
          body: JSON.stringify(params),
          signal,
        }).then(r => r.json());

        return {
          content: [{ type: "text", text: `✓ Email sent to ${params.to}` }],
          details: { messageId: result.id },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `✗ Failed: ${error.message}` }],
          error: true,
        };
      }
    },
  }));
};
```

### Example 2: Discord bridge (service + extension)

**Service (daemon-side):**

```typescript
import type { ServiceHandler } from "@pizzapi/extension-sdk";

class DiscordService implements ServiceHandler {
  readonly id = "discord";
  #discord: DiscordClient | null = null;
  #sessionThreads = new Map<string, string>(); // sessionId -> threadId

  init(socket, options) {
    this.#discord = new DiscordClient(process.env.DISCORD_TOKEN!);

    // Receive messages from session extensions
    socket.on("service_message", (data: any) => {
      if (data.serviceId !== "discord") return;
      const sessionId = data.payload.sessionId;

      if (data.type === "discord_post") {
        const threadId = this.#sessionThreads.get(sessionId);
        if (threadId) {
          this.#discord.postToThread(threadId, data.payload.content);
        }
      }
    });

    // Listen for Discord messages and forward to sessions
    this.#discord.on("message", async (msg) => {
      const sessionId = this.#sessionThreads.entries()
        .find(([, tid]) => tid === msg.threadId)?.[0];
      if (sessionId) {
        await broadcastTrigger("discord:message", {
          content: msg.content,
          author: msg.author.name,
          timestamp: Date.now(),
        });
      }
    });
  }

  dispose() {
    this.#discord?.close();
  }

  handleSessionEnded(sessionId: string) {
    this.#sessionThreads.delete(sessionId);
  }
}

export default new DiscordService();
```

**Extension (session-side):**

```typescript
import { sendServiceMessage } from "@pizzapi/extension-sdk";

export default (pi) => {
  pi.on("message_end", (event, ctx) => {
    // Forward assistant messages to Discord
    if (event.message.role === "assistant") {
      sendServiceMessage(pi.events, "discord", "discord_post", {
        content: event.message.content.map(c => c.text).join(""),
        sessionId: ctx.sessionManager.sessionId,
      });
    }
  });

  // Listen for incoming Discord messages
  pi.events.on("discord:message", (payload) => {
    // Inject into conversation
    pi.sendUserMessage(`[Discord] ${payload.author}: ${payload.content}`);
  });
};
```

---

## Quick Reference

| Task | How |
|------|-----|
| Subscribe to event | `pi.on("event_name", handler)` |
| Show dialog | `ctx.ui.confirm()`, `ctx.ui.select()`, `ctx.ui.input()` |
| Register tool | `pi.registerTool(defineTool({ ... }))` |
| Register command | `pi.registerCommand("name", { handler })` |
| Send message to agent | `pi.sendUserMessage("text")` |
| Detect PizzaPi | `detectPizzaPiHost(pi.events)` or `onPizzaPiHost(pi.events, callback)` |
| Request approval | `await requestApproval(pi.events, request)` |
| Send to service | `sendServiceMessage(pi.events, serviceId, type, payload)` |
| Broadcast trigger | `fetch(.../trigger-broadcast, POST)` with runnerId + apiKey |
| Register provider | `pi.registerProvider("name", { baseUrl, apiKey, models })` |
| Create runner service | Package + `pi.pizzapi.services` declaration + `ServiceHandler` + install + grant + restart |

---

## Common Pitfalls

| Problem | Solution |
|---------|----------|
| Import `@pizzapi/extension-sdk` in standalone extension | Type-import only; dynamic import in handlers. See pizzawork-host-provided-sdk-imports skill. |
| Service message received twice | Dedupe on `env.id` (at-least-once delivery). |
| Panel API returns no data | Add `Access-Control-Allow-Origin: *` header. |
| Panel context params undefined | Include var name in `panel.requires` (e.g. `"SESSION_ID"`). |
| Trigger handler blocks agent | Don't wait in a handler; use `deliverAs` to queue. |
| Approval doesn't show in UI | Ensure host is detected and has `"panels"` in capabilities. |
| Circular imports in extension | Avoid top-level imports of npm packages; use dynamic imports at handler time. |
| Extension loads twice on /reload | Remove event listeners in `session_shutdown` handler. |

---

## Authoritative References

- Pi core docs: `@earendil-works/pi-coding-agent` dist (installed in `node_modules`)
- PizzaPi overlay spec: `packages/docs/src/content/docs/customization/overlay-packages.mdx`
- Protocol types: `@pizzapi/protocol` (trigger, sigil, approval definitions)
- Service loader: `packages/cli/src/runner/package-service-loader.ts`
- Examples: `packages/cli/src/runner/services/` (built-in services: time, tunnel, etc.)
