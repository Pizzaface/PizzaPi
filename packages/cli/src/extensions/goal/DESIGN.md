# `/goal` Command Design

## Goal

Add a slash command `/goal` that lets the user declare a high-level success
condition for the current agent session. The extension then:

1. Tracks per-session **turn count** and **token spend**.
2. After each completed turn, asks a pluggable **evaluator** whether the goal
   condition is satisfied.
3. When the goal is met — or a budget (turns / tokens / cost) is exhausted —
   it triggers the existing **stop hook path** so the session ends cleanly and
   any configured `Stop` / `SessionShutdown` hooks run.

This design intentionally re-uses the upstream `registerCommand`,
`turn_end`/`agent_end`/`session_shutdown` events, the `appendEntry` persistence
mechanism, and the existing `ctx.shutdown()` / `ctx.abort()` stop flow instead
of inventing a parallel shutdown mechanism.

## Existing CLI command structure

PizzaPi binds upstream command actions in `runner/worker.ts` via
`session.bindExtensions({ commandContextActions: { ... } })`. Upstream
interactive/TUI mode dispatches slash commands such as `/new`, `/resume`,
`/loop`, `/clear` to handlers registered through the extension runtime.
PizzaPi adds its own slash commands by registering `ExtensionFactory` instances
in `extensions/factories.ts`, e.g. `/restart`, `/name`, `/plan`, `/remote`.

The `/goal` command follows the same pattern:

- New `extensions/goal/index.ts` extension factory.
- Registered in `buildPizzaPiExtensionFactories()` alongside the others.
- Uses `pi.registerCommand("goal", { handler, description })`.

## Stop hook mechanisms

There are several ways the runner/session can stop today:

1. **CLI `runner stop`** (`runner/stop.ts`) — kills the supervisor/daemon
   process from outside.
2. **`ctx.shutdown()`** in an extension/context — graceful exit that fires
   `session_shutdown` then exits the process.
3. **`ctx.abort()`** — aborts the in-flight agent turn; the loop ends and
   `agent_end` is emitted.
4. **Plugin hooks** (`extensions/hooks/extension.ts`) — shell scripts run on
   `SessionShutdown` and `TurnEnd`. The Claude Code `Stop` event is mapped to
   `agent_end` in `plugins/hooks.ts`.

`/goal` uses `ctx.shutdown()` for a clean, final stop when the condition is met
or a hard budget is hit. It uses `ctx.abort()` only as an emergency brake if
a turn is still streaming when the budget is exhausted. Both paths emit
`agent_end`/`session_shutdown`, so existing stop/session-shutdown hooks run
without modification.

## State model

```ts
// GoalCondition: what the user asked for
{
  description: string;           // natural-language success condition
  successKeywords?: string[];    // optional MVP keyword check
  evaluator: "llm" | "keyword";  // pluggable evaluator
}

// GoalBudget: guardrails
{
  maxTurns?: number;
  maxTokens?: number;
  maxCost?: number;              // USD
}

// GoalState: the live, per-session state
{
  id: string;
  condition: GoalCondition;
  budget: GoalBudget;
  status: "active" | "met" | "failed" | "cancelled";
  turnCount: number;
  tokenSpend: number;
  costSpend: number;
  evaluations: GoalEvaluatorFeedback[];
  createdAt: number;
  stoppedAt?: number;
  stopReason?: GoalStopReason;
}

// GoalEvaluatorFeedback: what the evaluator reported
{
  turnIndex: number;
  verdict: "met" | "not_met" | "uncertain";
  reason: string;
  tokensUsed?: number;           // cost of the evaluation itself
  model?: { provider: string; id: string };
  timestamp: number;
}
```

State is stored in an in-memory map keyed by session id. It is also persisted
into the session file as a `custom` entry with `customType: "goal_state"`, so
resumed sessions can reconstruct the active goal.

## Evaluation strategy

The evaluator is behind an interface:

```ts
export interface GoalEvaluator {
  evaluate(state: GoalState, context: GoalEvaluationContext): Promise<GoalEvaluatorFeedback>;
}
```

Two evaluator implementations are planned:

- `KeywordGoalEvaluator`: fast, local check of the last assistant message and
  tool results against `successKeywords`. Good for deterministic goals.
- `LlmGoalEvaluator`: sends a small side-prompt to a model (preferably a cheap
  one) asking whether the conversation satisfies the natural-language
  condition. This is stubbed; the real model call needs provider-specific
  wiring.

## Command syntax

```text
/goal "the tests pass and the README is updated" --max-turns 20 --max-tokens 100000
/goal fix the Dockerfile --evaluator keyword --keyword "build succeeded"
/goal clear
```

- Bare `/goal` or `/goal status` prints the active goal and current counters.
- `/goal clear` cancels the active goal.

## Files added / changed

### New files

- `extensions/goal/types.ts` — public interfaces.
- `extensions/goal/state.ts` — in-memory map + persistence helpers.
- `extensions/goal/parser.ts` — `/goal` argument parser.
- `extensions/goal/evaluator.ts` — evaluator interface + keyword stub.
- `extensions/goal/index.ts` — extension factory wiring command & events.
- `extensions/goal/goal.test.ts` — parser/state unit tests.
- `extensions/goal/DESIGN.md` — this document.

### Changed files

- `extensions/factories.ts` — add `goalExtension` to the factory list.
- `config/system-prompt.ts` — optionally mention `/goal` in the built-in system
  prompt so the model knows it exists.

## Open questions for implementation

1. Exact LLM evaluator plumbing. The extension API does not expose a generic
   "call model" method. Options:
   - Use the currently active model via provider-specific SDK calls.
   - Inject an `evaluate_goal` tool and let the model call it (simpler but
     requires a turn).
   - Use `before_agent_start` to prepend a system-prompt instruction that the
     agent should stop and report when the goal is met.
2. Whether to auto-stop when the LLM itself declares the goal is met, or only
   when the evaluator confirms.
3. Whether `/goal` should be allowed in sub-agent sessions.
