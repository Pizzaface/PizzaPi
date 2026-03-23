# Dish 006: .gitignore Cleanup (Chef's Special)

- **Cook Type:** jules
- **Complexity:** S
- **Godmother ID:** — (codebase exploration find)
- **Dependencies:** none
- **Priority:** P3
- **Status:** served

## Files
- `.gitignore` (modify)

## Verification
```bash
git status --porcelain  # reports/ and .playwright-cli/ should no longer show
```

## Task Description

Several directories that shouldn't be tracked are showing up in `git status`:

- `reports/` — Night Shift reports and artifacts (generated, machine-specific)
- `.playwright-cli/` — Playwright CLI cache/logs (tool-generated)
- `.python-version` — pyenv local config (developer-specific)

Add these three entries to the root `.gitignore` file. Place them in a clear section:

```gitignore
# Night Shift reports
reports/

# Tool artifacts
.playwright-cli/
.python-version
```
