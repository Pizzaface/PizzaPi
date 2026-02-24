---
name: at-file-mentions
description: Allow users to type @ in the prompt input to browse and insert file/folder paths from the runner's working directory
status: backlog
created: 2026-02-24T17:38:19Z
---

# PRD: at-file-mentions

## Executive Summary

Add an `@` mention system to the chat prompt input that lets users browse and reference files and folders from the connected runner's working directory. When a user types `@`, a popover appears (similar to the existing `/` slash command popover) showing the top-level files and directories. Users can drill into folders to navigate the file tree, and selecting a file or folder inserts its path as text into the message (e.g., `@packages/ui/src/App.tsx`).

This gives users a fast, discoverable way to reference specific files when communicating with the agent — no need to remember or manually type paths.

## Problem Statement

Currently, when users want to reference a specific file in their prompt to the agent, they must:
1. Manually type the full file path from memory
2. Switch to the file explorer panel, find the file, then manually type its path
3. Hope the agent infers the right file from a vague description

This is error-prone (typos in paths), slow (context-switching to the file explorer), and undiscoverable for new users. An `@` mention system — a pattern familiar from GitHub, Slack, and other tools — solves all three problems.

### Why now?

The file explorer and runner file listing API already exist (`/api/runners/{id}/files`). The slash command popover provides a proven UI pattern to extend. The infrastructure is in place; this is a high-leverage UX improvement.

## User Stories

### Primary Persona: Developer using PizzaPi to interact with an agent

**US-1: Basic file reference**
> As a user, I want to type `@` in the prompt input and see a list of files and folders in the project root so I can quickly reference them.

*Acceptance Criteria:*
- Typing `@` shows a popover with top-level files and directories from the runner's CWD
- Files and folders are visually distinguished (icons)
- The popover appears inline, anchored near the cursor/input area (similar to slash commands)

**US-2: Folder navigation**
> As a user, I want to select a folder in the `@` popover to drill into it and see its contents, so I can navigate to deeply nested files.

*Acceptance Criteria:*
- Selecting a directory in the popover replaces the list with that directory's contents
- A back/parent navigation option is visible to go up one level
- The current path is displayed in the popover header
- Selecting a directory updates the `@` text in the input to reflect the current path (e.g., `@packages/ui/`)

**US-3: File selection inserts path as text**
> As a user, I want selecting a file to insert its full relative path into my message so the agent knows exactly which file I'm referring to.

*Acceptance Criteria:*
- Selecting a file inserts the path as text: `@path/to/file.tsx` followed by a space
- The popover closes after selection
- The cursor is positioned after the inserted path for continued typing
- Selecting a folder (as a final choice, e.g., via a "select folder" action) inserts `@path/to/folder/`

**US-4: Fuzzy filtering**
> As a user, I want to type after `@` to filter the file list so I can quickly find files by name.

*Acceptance Criteria:*
- Typing characters after `@` filters the current directory listing (e.g., `@pack` shows only entries matching "pack")
- Filtering is case-insensitive
- Filtering works at every directory level during drill-down

**US-5: Dismiss popover**
> As a user, I want to dismiss the `@` popover with Escape or by clicking outside, without inserting anything.

*Acceptance Criteria:*
- Pressing Escape closes the popover and leaves the `@` text as-is
- Clicking outside the popover closes it
- The user can continue typing normally after dismissal

## Requirements

### Functional Requirements

**FR-1: Trigger detection**
- Detect `@` character in the prompt input text
- Trigger the popover when `@` is typed at the start of input or after a whitespace character (not mid-word like `email@`)
- Track the position of the `@` trigger for text replacement on selection

**FR-2: File listing popover**
- Display a Command/combobox popover (reuse existing `Command` UI components from shadcn)
- Show files and folders from the runner's CWD via the existing `/api/runners/{id}/files` API
- Display file/folder icons (reuse icons from `FileExplorer` component)
- Sort: directories first, then files, both alphabetically
- Hide hidden files/folders (starting with `.`) by default

**FR-3: Directory navigation**
- Clicking a folder drills into it, fetching its contents via the same API
- Show a breadcrumb or "← Back" option to navigate to parent directory
- Update the `@` text in the input field as the user navigates (e.g., `@src/` while browsing `src/`)

**FR-4: Selection and insertion**
- On file selection: replace the `@...` token in the input with `@relative/path/to/file ` (with trailing space)
- On folder selection (explicit): replace with `@relative/path/to/folder/`
- Maintain cursor position after the inserted text

**FR-5: Keyboard navigation**
- Arrow keys navigate the list (handled by Command component)
- Enter selects the highlighted item (file → insert, folder → drill in)
- Tab could also be used to autocomplete/drill in (matching slash command behavior)
- Escape dismisses the popover

**FR-6: State management**
- The popover should close when:
  - A file is selected
  - User presses Escape
  - User deletes the `@` trigger character
  - User clicks outside the popover
  - The input loses focus
- The popover should persist when navigating between folders

### Non-Functional Requirements

**NFR-1: Performance**
- File listing requests should complete within 500ms for typical projects
- Cache directory listings for the duration of the popover being open (invalidate on close)
- Debounce filter input by ~100ms to avoid excessive re-renders

**NFR-2: Responsiveness**
- Popover must work on both desktop and mobile viewports
- On mobile, the popover should not overlap the keyboard
- Touch-friendly tap targets for folder navigation

**NFR-3: Accessibility**
- Popover is keyboard-navigable (Arrow keys, Enter, Escape)
- Screen reader announces the file list and current path
- ARIA attributes on the popover (role, aria-label, etc.)

## Success Criteria

| Metric | Target |
|--------|--------|
| Time to reference a file | < 5 seconds (vs. manual typing) |
| Popover render time | < 300ms after typing `@` |
| User can navigate 3 levels deep | Without errors or lag |
| Works on mobile Safari/Chrome | Popover is usable on touch devices |

## Constraints & Assumptions

- **Requires active runner connection**: The `@` mention feature only works when connected to a runner (the file listing API needs a runner). When no runner is connected, `@` should not trigger the popover.
- **Relative paths only**: All paths are relative to the runner's CWD. Absolute paths are not supported.
- **Existing API**: The `/api/runners/{id}/files` endpoint already supports listing files with a `path` parameter. No backend changes should be needed.
- **No file content preview**: This feature inserts paths only — it does not preview file contents in the popover (that could be a follow-up).

## Out of Scope

- **File content preview** in the popover (hover to see file contents)
- **Multi-file selection** (selecting multiple files at once)
- **Syntax highlighting** of `@path` tokens in the textarea (would require a rich text editor)
- **Git-aware sorting** (showing changed files first) — nice-to-have for future iteration
- **Glob patterns** (e.g., `@src/**/*.tsx`) — not in v1
- **Cross-runner file browsing** — only the current session's runner

## Dependencies

- **Existing `/api/runners/{id}/files` API** — provides directory listings
- **Existing `Command` UI components** (shadcn) — for the popover list
- **Existing slash command popover pattern** in `SessionViewer.tsx` — architectural reference
- **FileExplorer icons** — reuse file/folder icon logic

## Technical Notes

The implementation should follow the existing slash command pattern in `SessionViewer.tsx`:
- The slash command popover tracks `commandOpen` state and `commandQuery` for filtering
- A similar `atMentionOpen` / `atMentionQuery` / `atMentionPath` state set can be used
- The `onChange` handler in `PromptInputTextarea` already parses input for `/` — extend it to detect `@`
- Directory contents should be fetched via `fetch(\`/api/runners/\${runnerId}/files\`, { method: "POST", body: JSON.stringify({ path }) })`
- The popover can be placed in the same location as the slash command popover (they are mutually exclusive)
