# Dish 003: Mobile SessionViewer Header Overflow Menu

- **Cook Type:** sonnet
- **Complexity:** M
- **Band:** B (clarityScore=73, riskScore=34, confidenceScore=53)
- **Godmother ID:** 9VOMwKS9 (related — mobile UX audit)
- **Pairing:** session-viewer-polish (role: prelim — must plate before Dish 004 dispatches)
- **Paired:** true
- **Pairing Partners:** 004-markdown-copy-polish
- **Dependencies:** none
- **dispatchPriority:** normal (Band B — dispatch after at least one expo pass or if no Band A dishes eligible)
- **Files:**
  - `packages/ui/src/components/SessionViewer.tsx` (primary — overflow menu, new props)
  - `packages/ui/src/App.tsx` (pass isTerminalOpen/isFileExplorerOpen/isGitOpen props)
- **Verification:** `bun run typecheck` + sandbox visual at mobile viewport
- **Status:** ramsey-cleared
- **Session:** ede08d5e-a607-4a64-9f25-f3626f4e6ae7

## Ramsey Report — 2026-03-26 03:54 UTC
- **Verdict:** pass
- **Demerits found:** 4 (P0: 0, P1: 0, P2: 1, P3: 3)
- **Automated gates:** typecheck: pass, tests: 646/0, sandbox: 2 screenshots taken

### Demerits
- P2: HeaderOverflowMenu missing useEffect cleanup for copy-state timer
- P3: `|| true` makes hasItems guard dead code
- P3: Duplicate Session uses same Copy icon as Copy as Markdown
- P3: Separator renders when show*Button=true but handler undefined

### Summary
Breakpoint logic correct. Export handlers faithful. Active checkmarks work. End Session/New Conversation untouched. extraHeaderButtons always visible. Clean pass.

## Task Description

### Objective
On mobile (`< md` breakpoint), collapse Terminal/Files/Git/Export/Duplicate session header buttons into a single "⋯" DropdownMenu. End Session (destructive) and New Conversation (plus) remain always visible. Desktop layout unchanged.

### Branch Setup
```bash
git checkout main
git checkout -b nightshift/dish-003-mobile-overflow-menu
```

### Part 1: New Props on SessionViewerProps

Add to the `SessionViewerProps` interface (after `showGitButton`):
```typescript
/** Whether the terminal panel is currently visible */
isTerminalOpen?: boolean;
/** Whether the file explorer panel is currently visible */
isFileExplorerOpen?: boolean;
/** Whether the git panel is currently visible */
isGitOpen?: boolean;
```

### Part 2: HeaderOverflowMenu Component

Add a new internal component ABOVE the `SessionViewer` function:
```typescript
interface HeaderOverflowMenuProps {
  showTerminalButton?: boolean;
  onToggleTerminal?: () => void;
  isTerminalOpen?: boolean;
  showFileExplorerButton?: boolean;
  onToggleFileExplorer?: () => void;
  isFileExplorerOpen?: boolean;
  showGitButton?: boolean;
  onToggleGit?: () => void;
  isGitOpen?: boolean;
  onDuplicateSession?: () => void;
  messages: RelayMessage[];
  sessionId: string | null;
}
```

The component renders a `md:hidden` DropdownMenu trigger (MoreHorizontal icon, `h-7 w-7` button):
- Menu items: Terminal, Files, Git (show active checkmark if open), separator, Copy as Markdown, Download Markdown, separator (if duplicate), Duplicate Session
- "Copy as Markdown" uses `exportToMarkdown([...messages])` and copies to clipboard
- "Download Markdown" creates blob download

Import `exportToMarkdown` from `@/lib/export-markdown` (dynamic import OK to reduce initial bundle).

### Part 3: Desktop buttons — add `hidden md:inline-flex`

For the Terminal, Files, and Git buttons, change their className to include `hidden md:inline-flex` so they're hidden on mobile. The `ConversationExport` and Duplicate buttons should also get `hidden md:inline-flex`.

Keep `extraHeaderButtons` (ServicePanelButtons) visible on both breakpoints — they have their own labels and are important enough to always show.

### Part 4: Add DropdownMenu to SessionViewer.tsx imports

Add to existing ui import:
```typescript
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
```

Add to lucide import: `MoreHorizontal, Check, Download, Share2`

### Part 5: App.tsx — pass new props

In `App.tsx`, where `<SessionViewer>` is rendered, add:
```tsx
isTerminalOpen={showTerminal}
isFileExplorerOpen={showFileExplorer}
isGitOpen={showGit}
```

### Part 6: Import exportToMarkdown in SessionViewer.tsx
```typescript
import { exportToMarkdown } from "@/lib/export-markdown";
```

### Sandbox Verification (MANDATORY)
```bash
# Build
bun run build

# Start sandbox
screen -dmS sandbox bash -c 'cd packages/server && exec bun tests/harness/sandbox.ts --headless --redis=memory > /tmp/sandbox-out.log 2>&1'
sleep 8
VITE_PORT=$(grep "UI (HMR)" /tmp/sandbox-out.log | grep -o 'localhost:[0-9]*' | cut -d: -f2)

# Log in
playwright-cli open "http://127.0.0.1:${VITE_PORT}"
playwright-cli snapshot
playwright-cli fill <email-ref> "testuser@pizzapi-harness.test"
playwright-cli fill <password-ref> "HarnessPass123"
playwright-cli snapshot
playwright-cli click <sign-in-ref>
sleep 2

# Take screenshot at mobile viewport (375px) to verify ⋯ menu appears
# Use playwright-cli with device emulation if available, or note viewport
playwright-cli screenshot   # screenshot 1: logged in state

# Check the session header for the ⋯ button
playwright-cli snapshot  # find MoreHorizontal / "More options" button ref
playwright-cli click <more-options-ref>
playwright-cli screenshot   # screenshot 2: overflow menu open, showing Terminal/Files/Git/Export/Duplicate

# Clean up
playwright-cli close
screen -S sandbox -X quit
```

**Required evidence:** Screenshot showing the ⋯ menu open with labeled items. Attach screenshot path to this dish file.

### Commit Message
```
feat(ui): mobile overflow menu for SessionViewer header

Collapse Terminal/Files/Git/Export/Duplicate buttons into a '⋯'
DropdownMenu on mobile (<md). Desktop layout unchanged. Active panels
show checkmarks. Includes Copy as Markdown and Download Markdown.

Adds isTerminalOpen/isFileExplorerOpen/isGitOpen props to SessionViewerProps
and passes them from App.tsx.

Related: 9VOMwKS9
```
