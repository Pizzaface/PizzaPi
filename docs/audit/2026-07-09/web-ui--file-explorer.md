# Audit: web-ui/file-explorer.mdx
Verdict: MINOR ISSUES
Claims checked: 38 | Failed: 9

## Findings

### [P2] "fuzzy match" is actually case-insensitive substring match
- Claim (line ~135 table): "Filename search string (fuzzy match)"
- Reality: The runner filters `git ls-files` output with `line.toLowerCase().includes(lowerQuery)` — a plain case-insensitive substring contains check, not fuzzy matching. (packages/cli/src/runner/services/file-explorer-service.ts:179-185)
- Fix: Change "fuzzy match" to "case-insensitive substring match".

### [P2] File search only covers git-tracked files and silently returns nothing in non-git repos
- Claim (line ~130): "PizzaPi searches the runner's workspace and presents matching files as suggestions."
- Reality: Search runs `git ls-files --cached --others --exclude-standard`; on git failure it returns `{ ok: true, files: [] }` with no error. Untracked-but-ignored files and non-git workspaces get zero results. (packages/cli/src/runner/services/file-explorer-service.ts:166-205)
- Fix: Document that search is git-based and only returns tracked + non-ignored files; note empty results in non-git workspaces.

### [P2] Markdown viewer (rendered preview + raw toggle) is undocumented
- Claim (line ~73 "Text Files"): "Text files open in a read-only monospaced preview with syntax-appropriate formatting."
- Reality: `.md`/`.mdx` files route to a dedicated `MarkdownViewer` with a "Preview" (rendered via LazyStreamdown) / "Raw" toggle, separate from the plain `FileViewer`. (packages/ui/src/components/file-explorer/FileExplorer.tsx:275-285; packages/ui/src/components/file-explorer/markdown-viewer.tsx; utils.ts `MARKDOWN_EXTENSIONS`)
- Fix: Add a "Markdown Files" subsection describing the Preview/Raw toggle.

### [P2] Git Blame button in file/markdown viewers is undocumented
- Claim (line ~150 tip): "the file explorer is read-only. You cannot edit, rename, or delete files."
- Reality: Both `FileViewer` and `MarkdownViewer` render a "Blame" button (toggling `GitBlameView`) when `canBlame` is true (git available + status). This is a real interactive feature in the viewer, omitted entirely. (packages/ui/src/components/file-explorer/file-viewer.tsx:69-80,97; markdown-viewer.tsx:94-105)
- Fix: Document the Blame toggle in the Viewing Files section.

### [P2] "Expand all" / "Collapse all" toolbar buttons not mentioned
- Claim (line ~66): "Use the refresh button (↻) to re-fetch the directory listing."
- Reality: The toolbar also has "Expand all (up to 3 levels)" and "Collapse all" buttons alongside refresh. (packages/ui/src/components/file-explorer/FileExplorer.tsx:300-340)
- Fix: Mention expand-all/collapse-all controls in the Navigating Directories section.

### [P3] Transparency checkerboard is always shown, not only for alpha images
- Claim (line ~89): "images with alpha channels display over a checkerboard background"
- Reality: The checkerboard div wraps every rendered image unconditionally; there is no alpha detection. (packages/ui/src/components/file-explorer/image-viewer.tsx:174-189)
- Fix: Say the checkerboard is always shown behind images (which conveniently handles transparency).

### [P3] `size` is returned for directories too, not only files
- Claim (line ~120): "size in bytes (for files)"
- Reality: `list_files` sets `size` from `stat()` for every entry including directories. (packages/cli/src/runner/services/file-explorer-service.ts:74-81)
- Fix: Say "size in bytes (for files and directories)" or note directory size is present but meaningless.

### [P3] Folder toggle button is hidden below the `md` breakpoint
- Claim (line ~13): "You can also click the folder icon button in the session viewer header bar."
- Reality: The button uses `hidden md:inline-flex`, so it is invisible on small/mobile viewports. (packages/ui/src/components/SessionViewer.tsx:675)
- Fix: Note the header button is desktop-only; on mobile use the keyboard shortcut (which works everywhere).

### [P3] Search response includes extra fields not shown in the example
- Claim (line ~143 response): `{ "name": "Button.tsx", "path": "..." }`
- Reality: Runner returns `{ name, path, relativePath, isDirectory: false, isSymlink: false }`. (packages/cli/src/runner/services/file-explorer-service.ts:186-192)
- Fix: Either show the full shape or note additional fields are present.

## Redesign notes
- The "Viewing Files" section conflates all text files; splitting into Text / Markdown / Images / Binary would surface the markdown preview and blame features the current prose hides.
- The REST API section is well-structured; the search-files table and read-file size/timeout table are the most useful parts and are accurate.
- "Known Limitations" is good and honest; the "No file search UI in the explorer panel" item could cross-link to the @-mention section.
- The workspace-root enforcement section is accurate and well-caveated; keep the caution aside about unscoped runners.

## Code UX opportunities
- Search silently returning `[]` for non-git workspaces (and for ignored files) is a real footgun — consider surfacing a "not a git repo" hint in the @-mention UI rather than an empty dropdown.
- The substring-vs-fuzzy mismatch suggests either renaming the API field description or implementing actual fuzzy ranking (e.g. fuzzysort) since users expect `@butn` to match `Button.tsx`.
- Symlinks-to-directories render as non-expandable files (readdir `isSymbolicLink()` returns true, `isDirectory()` false), so users can't browse into them — consider resolving symlinks-to-dirs into expandable folders like `browse_directory` already does.
- The header toggle button being `hidden md:inline-flex` means mobile users have no visible entry point; a mobile-friendly affordance or a visible hint would help.
