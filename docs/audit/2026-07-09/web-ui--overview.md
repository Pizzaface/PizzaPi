# Audit: web-ui/overview.mdx
Verdict: MINOR ISSUES
Claims checked: 83 | Failed: 7

## Findings

### [P2] Keyboard shortcuts table omits the Session History shortcut
- Claim (line 39, table): The shortcuts table lists ⌘K, Ctrl+`, ⌘⇧E, ⌘., ? — but does NOT list the session-history shortcut.
- Reality: `ShortcutsDialog.tsx:42` renders a sixth row `{ key: isMac ? "⌘⇧H" : "Ctrl+Shift+H", action: "Session history" }`, and `App.tsx:4130-4135` binds `meta && e.shiftKey && e.key.toLowerCase() === "h"` to toggle the history palette. The dialog the doc tells users to open shows a shortcut the doc table doesn't mention. (packages/ui/src/components/ShortcutsDialog.tsx:42; packages/ui/src/App.tsx:4130)
- Fix: Add a row `| <kbd>⌘⇧H</kbd> / <kbd>Ctrl+Shift+H</kbd> | Toggle session history |` to the table.

### [P2] "Drag an individual tab to detach it to a different zone" is misleading
- Claim (line 61): "Tab dragging — Drag an individual tab out of a panel to detach it to a different zone."
- Reality: A tab's `onDragStart` is wired to `handleGroupDragStart(zoneTabIds)` → `startPanelDragWith(e, (pos) => handleGroupPositionChange(tabIds, pos))`, which moves the **entire group/panel** co-located in that zone, not the individual tab. `CombinedPanel.tsx` comment confirms: "dragging the tab triggers panel repositioning instead of tab switching." There is no per-tab detach. (packages/ui/src/App.tsx:4832-4834, 5198; packages/ui/src/components/CombinedPanel.tsx:65-66)
- Fix: Reword to "Drag a tab to reposition the whole panel into a new zone" — individual tabs cannot be detached.

### [P2] "Sure?" revoke confirmation auto-dismisses in 3 seconds — actually 5
- Claim (line 193): "a 'Sure?' confirmation appears for 3 seconds before auto-dismissing."
- Reality: `DeleteKeyButton` sets `setTimeout(() => setConfirming(false), 5000)` — 5000 ms, not 3000. The same 5 s applies to `RunnerTokenManager`'s `DeleteTokenButton`. (packages/ui/src/components/ApiKeyManager.tsx:21; packages/ui/src/components/RunnerTokenManager.tsx:21)
- Fix: Change "3 seconds" to "5 seconds".

### [P3] "?" shortcut is not available "anywhere in the UI"
- Claim (line 31): "Press **<kbd>?</kbd>** anywhere in the UI to open the keyboard shortcuts dialog."
- Reality: The handler explicitly skips when `inInput` (INPUT/TEXTAREA/contentEditable) is true, when any modifier is held, or when `document.querySelector('[role="dialog"]')` already exists (a dialog is open). (packages/ui/src/App.tsx:4096-4104)
- Fix: Say "Press ? outside of inputs and dialogs to open…".

### [P3] Context donut location described as "session toolbar" — it's the composer footer
- Claim (line 91): "It appears in the session toolbar whenever context token data is available."
- Reality: `ContextDonut` is rendered inside `PromptInputFooter` next to `ComposerAttachmentButton` and `ComposerSubmitButton`, i.e. the prompt composer footer, not a session toolbar. (packages/ui/src/components/SessionViewer.tsx:1737-1745)
- Fix: Say "appears in the prompt composer footer" or "next to the send button".

### [P3] Olives described as "dark rings" — rendered as filled dark circles
- Claim (line 133): "dark rings for olives".
- Reality: The olive renderer is `<circle r="3.5" fill="#1a1a1a" stroke="#333">` plus an inner `<circle r="1.5" fill="#4a5568">` — a filled dark disc with a center dot, not a ring (unlike onions, which are genuinely `fill="none" stroke="#a855f7"`). (packages/ui/src/components/session-viewer/cards/PizzaProgress.tsx:137-143)
- Fix: Say "dark discs for olives" (or "dark olive slices").

### [P3] Haptic feedback section duplicates preferences.mdx
- Claim (lines 20-27): A full "Haptic feedback" subsection lives here, but the page intro (line 8) says it "covers the smaller features that don't have their own dedicated doc page."
- Reality: `packages/docs/src/content/docs/web-ui/preferences.mdx:92-97` already contains a near-identical "Haptic feedback" subsection (same Vibration API link, same iOS-Safari note). The overview intro contradicts itself by hosting a duplicated topic. (packages/docs/src/content/docs/web-ui/preferences.mdx:92-97)
- Fix: Replace the overview subsection with a one-line cross-link to preferences.mdx, or remove the "don't have their own dedicated doc page" framing.

## Redesign notes
- The page is a long grab-bag; the intro promises "smaller features" but then includes deep, full-feature sections (panel 9-zone grid, hidden-models manager, API keys/runner tokens) that arguably warrant their own pages or belong in preferences.mdx / a security page. Consider splitting.
- The keyboard-shortcuts table is the natural place users discover shortcuts; keeping it in sync with `ShortcutsDialog.tsx` is fragile. Consider generating the table from the same source array the dialog uses.
- "Panel positioning & resize" overlaps with `terminal.mdx:16` and `file-explorer.mdx:22`, which both describe the position picker / grip handle. The overview's 9-zone explanation is the canonical one; cross-link instead of re-explaining in each panel page.
- The pizza-progress stage table (lines 121-129) is presented as if universal, but only matches lists ≥4 items; the scaling caveat comes two paragraphs later. Invert the order: explain scaling first, then give the canonical large-list table.
- Runner-token "How to use" snippet in the UI (`RunnerTokenManager.tsx`) also runs `bun run dev:runner` — the doc lists only env vars and omits the launch command, a missed opportunity to align doc with the in-app snippet.

## Code UX opportunities
- `DeleteKeyButton`/`DeleteTokenButton` auto-dismiss at 5 s with no visible countdown; users may miss the window. A tiny countdown ring or persistent-until-blur would be friendlier than a fixed timer — and the doc shouldn't have to track the exact ms.
- The tab-drag = whole-panel-move behavior is non-obvious; the cursor stays `cursor-grab` on individual tabs, implying per-tab detach. Either support true tab detach, or change the tab cursor/tooltip to "Drag to move panel."
- `ShortcutsDialog` and the docs table drift independently. Exposing the shortcut list from a single exported constant (and having the dialog map over it) would let docs be auto-generated and eliminate the missing-shortcut class of bug.
- `supportsHaptics()` returns false on iOS, so the toggle silently disappears; consider a disabled state with a tooltip ("Not supported on this browser") instead of hiding, so users understand why.
- `ContextDonut` lives in the composer footer but is described as a "session toolbar" element — naming the surrounding container a "toolbar" in the UI (aria-label) would make the doc claim true and aid screen-reader users.
