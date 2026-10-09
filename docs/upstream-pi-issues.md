# Upstream pi TUI issue drafts

Ready-to-file issue drafts for `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui`
(the upstream `pi` CLI/TUI that PizzaPi vendors as a patched dependency). These are
deliberately **not patched locally** — each lives only in vendored `node_modules`, so a
local patch costs a hunk per item plus re-porting on every `pi` bump. File these upstream
instead; only patch if one starts actually biting PizzaPi users.

Re-verified against the currently pinned version: `@earendil-works/pi-coding-agent@1.0.0`,
`@earendil-works/pi-tui@1.0.0` (see `package.json`). All 4 are still present.

Godmother reference: `b6GxF39s`.

---

## 1. (P2) Failed bash command loses exit info and is never recorded in session history

**Where:** `@earendil-works/pi-coding-agent`, `dist/core/agent-session.js` (`AgentSession.executeBash`,
around line 3075) and `dist/modes/interactive/interactive-mode.js`
(`InteractiveMode.handleBashCommand`'s normal-execution catch block, around line 5834).

**Repro:**
1. Start the interactive TUI.
2. Run a bash command that throws before producing a result, e.g. `!this-binary-does-not-exist-xyz`
   (anything that makes `executeBashWithOperations` reject rather than resolve with a
   `{ exitCode, ... }` result).

**Expected:** The failed command is recorded in session history (as a `bashExecution`
message, same as a successful command) with whatever exit/error information is available,
so `/history`, transcript exports, and anything else reading session messages can see that
the command ran and failed.

**Actual:** `AgentSession.executeBash` only calls `this.recordBashResult(...)` on the
success path, inside the `try` block right after `executeBashWithOperations` resolves. If
it throws, `recordBashResult` is never called. The TUI's catch block in
`handleBashCommand` mirrors this: it calls `this.bashComponent.setComplete(undefined, false)`
(no exit code, no error flag) and shows a `showError(...)` line in the UI, but never calls
`session.recordBashResult`. The user sees the error once in the live UI, but the session's
message history has no record the command ever ran. This is a history/UX-fidelity gap, not
a silently swallowed error.

**Suggested fix:** In `AgentSession.executeBash`, wrap the `executeBashWithOperations` call
so a thrown error is converted into a result shape (e.g. `exitCode: null`/`-1`,
`output: error.message`) and still passed to `recordBashResult` before rethrowing (or
instead of rethrowing, if the TUI is expected to treat the recorded result as the signal).
Alternatively, have `interactive-mode.js`'s catch block call
`this.session.recordBashResult(command, { output: error.message, exitCode: null, cancelled: false }, { excludeFromContext })`
before/alongside `showError`.

---

## 2. (P2) Pending bash cards are stranded when the agent finishes before the next submit

**Where:** `@earendil-works/pi-coding-agent`, `dist/modes/interactive/interactive-mode.js`:
`flushPendingBashComponents()` (defined around line 3901) has exactly one call site, in the
"normal message submission" branch of the input-submit handler (around line 2670). The
"agent is streaming" branch directly above it (around line 2656-2663) returns early via
`await this.session.prompt(text, { streamingBehavior: "steer" })` without ever reaching the
flush call. The `agent_end` and `agent_settled` event handlers (around lines 2891 and 2904)
don't call it either.

**Repro:**
1. Start a long-running agent turn.
2. While it's streaming, run a `!bash command` — it gets queued into
   `pendingBashComponents`/`pendingMessagesContainer` (shown above the editor, not yet in
   chat history).
3. Let the agent turn finish on its own (don't submit another message).

**Expected:** Once the agent settles, the queued bash card(s) move into the normal chat
history like any other pending content.

**Actual:** The bash card(s) stay stranded in the pending-messages area above the editor
indefinitely. They only get flushed into `chatContainer` the next time the user submits a
*normal* (non-streaming, non-slash) message — i.e. `flushPendingBashComponents()`'s only
caller sits in a code path that requires another user submission while idle.

**Suggested fix:** Also call `this.flushPendingBashComponents()` in the `agent_end` (or
`agent_settled`) event handler, mirroring the existing pending-messages-display flush that
already happens in the streaming submit path (`this.updatePendingMessagesDisplay()`).

---

## 3. (P3) `showWarning` hardcodes the output pad instead of using `this.outputPad`

**Where:** `@earendil-works/pi-coding-agent`, `dist/modes/interactive/interactive-mode.js`,
`InteractiveMode.showError` (line ~3715) vs. `InteractiveMode.showWarning` (line ~3720).

```js
showError(errorMessage) {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new ThemedText(() => theme.fg("error", `Error: ${errorMessage}`), this.outputPad, 0));
    this.ui.requestRender();
}
showWarning(warningMessage) {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new ThemedText(() => theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
    this.ui.requestRender();
}
```

**Repro:** Set a non-default output pad (`outputPad` setting > 1), then trigger both an
error (e.g. an invalid command) and a warning (e.g. the "bash command already running"
warning) in the same session.

**Expected:** Error and warning lines indent consistently, both honoring the configured
`outputPad`.

**Actual:** `showWarning` always indents by a literal `1`, while `showError` indents by
`this.outputPad`. When `outputPad > 1` the two message types visibly misalign.

**Suggested fix:** Change `showWarning`'s hardcoded `1` to `this.outputPad`, matching
`showError`.

---

## 4. (P3) `extractAnsiCode`'s CSI terminator set is incomplete

**Where:** `@earendil-works/pi-tui`, `dist/utils.js`, `ansiCodeLength()` (around line 401-412).

```js
// CSI sequence: ESC [ ... m/G/K/H/J
if (next === "[") {
    for (let j = pos + 2; j < str.length; j++) {
        const c = str.charCodeAt(j);
        // m, G, K, H, J
        if (c === 0x6d || c === 0x47 || c === 0x4b || c === 0x48 || c === 0x4a)
            return j + 1 - pos;
    }
    return 0;
}
```

**Repro:** Feed a string containing a CSI sequence whose final byte is one of the other
valid ANSI final bytes (e.g. cursor-movement sequences `ESC [ <n> A/B/C/D`, or `E/F/f/n/s/u`)
into any of `extractAnsiCode`/`ansiCodeLength`'s callers (`visibleWidth`,
`asciiVisibleWidth`, line-wrapping helpers, etc.).

**Expected:** The full CSI sequence is recognized and its length computed, so it's excluded
from visible-width calculations like any other escape sequence.

**Actual:** The terminator scan only matches `m` (SGR/color), `G`, `K`, `H`, `J` (cursor
column/erase/position codes). Final bytes `A`, `B`, `C`, `D` (cursor up/down/forward/back),
`E`, `F` (cursor next/previous line), `f` (HVP), `n` (DSR), `s`/`u` (save/restore cursor),
and others are not recognized as terminators, so the loop runs to the end of the string
without matching and returns `0` (no escape sequence found). A CSI sequence using one of
those final bytes would then be measured as visible text by width-calculation code,
breaking width math for any content containing it.

Currently latent: SGR (`m`, i.e. color codes) is the common case in practice — including
PizzaPi's own terminal-notification strings — so this has not been observed causing visible
corruption. Flagging for upstream awareness since the fix is a strict superset of the
current terminator check.

**Suggested fix:** Broaden the terminator check to the full CSI final-byte range
(`0x40`-`0x7e`, i.e. `@` through `~`), per the ECMA-48 / ANSI X3.64 definition of a CSI
sequence, rather than enumerating only the final bytes `pi-tui` happens to emit itself.
