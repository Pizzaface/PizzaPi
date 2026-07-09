# Audit: web-ui/terminal.mdx
Verdict: MINOR ISSUES
Claims checked: 28 | Failed: 4

## Findings

### [P1] Shell fallback is /bin/bash on macOS, not /bin/zsh
- Claim (line ~38): "The runner auto-detects your default shell (`$SHELL`, or falls back to `/bin/zsh` on macOS, `/bin/bash` on Linux)."
- Reality: `resolveDefaultShell()` returns `process.env.SHELL` or, on any non-Windows platform, `/bin/bash`. There is no macOS-specific `/bin/zsh` branch. (packages/cli/src/runner/terminal-utils.ts:36-39; confirmed by test at terminal-utils.test.ts:123-125 which asserts `/bin/bash` on macOS/Linux)
- Fix: Change to "falls back to `/bin/bash` on macOS/Linux (PowerShell on Windows)".

### [P2] "new_terminal" is not forwarded at POST time — spawn is deferred
- Claim (line 34): "the UI sends a `POST /api/runners/terminal` request to the relay server, which registers the terminal and forwards a `new_terminal` command to the runner."
- Reality: The POST handler only `registerTerminal()`s and returns the terminalId; the `new_terminal` emit to the runner happens later, on the viewer's first `terminal_resize` (deferred spawn). (packages/server/src/routes/runners.ts:317-355; packages/server/src/ws/namespaces/terminal.ts:151-183)
- Fix: Say "registers the terminal; the PTY is spawned on the runner when the browser sends its first resize (deferred spawn)."

### [P3] "Process exited" message text differs from actual
- Claim (line ~96): "the tab shows a 'Process exited' message and disconnects."
- Reality: The actual line written is `[Process exited with code ${exitCode}]` (grayscale). (packages/ui/src/components/WebTerminal.tsx:186-190)
- Fix: Quote the real string or paraphrase as "shows the exit code and disconnects".

### [P3] Ctrl+` shortcut scope omits Windows
- Claim (line ~13): "**Ctrl** + **`** ... works on both macOS and Linux."
- Reality: The handler keys off `e.ctrlKey` with no platform gate, so it works on Windows too. (packages/ui/src/App.tsx:4117-4122; ShortcutsDialog.tsx:40 lists it unconditionally)
- Fix: Say "works on macOS, Linux, and Windows" (or just "always uses Ctrl").

## Redesign notes
- The "How it works" numbered list (lines 33-38) is the most error-prone section: it collapses register + deferred-spawn + resize-trigger into one step. Splitting "register" from "spawn" would match the code and make the deferred-spawn behavior discoverable.
- The mobile-shortcuts and limitations sections are accurate and well-scoped; no changes needed there.
- Security section is accurate and appropriately cautious; the "no additional sandboxing" point is a genuinely useful distinction from agent sessions.

## Code UX opportunities
- On browser refresh the PTY is NOT killed server-side (removeTerminalViewer only detaches the viewer; spawned terminals have no GC timer). The UI loses the tab but the orphaned PTY keeps running on the runner indefinitely. Either persist terminalIds in localStorage to allow reconnect, or kill the PTY after a viewer-disconnect grace period. (packages/server/src/ws/sio-registry/terminals.ts:136-152)
- The deferred-spawn design means a terminal that never receives a resize sits "registered but unspawned" for 60s then GCs — worth surfacing in the UI as "Connecting…" vs a silent failure.
- Shell fallback to `/bin/bash` on macOS is itself surprising (most macOS users expect zsh); consider defaulting to `/bin/zsh` on darwin, which would also make the docs' original claim true.
