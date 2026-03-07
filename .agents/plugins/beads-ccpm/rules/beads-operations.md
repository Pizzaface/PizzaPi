# Beads Operations Rule

Standard patterns for Beads task management operations across all PM commands.

## Overview

Beads is a git-backed, local-first task management system that replaces direct GitHub issue operations. Tasks are stored in `.beads/` and tracked with hash-based IDs (e.g., `reclux-a1b2c3`).

## Initialization Check

**Before ANY Beads operation:**

```bash
# Check if Beads is initialized
if [ ! -d ".beads" ]; then
  echo "❌ Beads not initialized. Run: bd init"
  exit 1
fi
```

## Core Commands

### Show Available Work

```bash
bd ready                              # Issues with no blockers
bd list --status=open                 # All open issues
bd list --status=in_progress          # Active work
```

### View Issue Details

```bash
bd show <id>                          # Full details with dependencies
bd show <id> --json                   # JSON output for parsing
```

### Create Issue

```bash
# Basic task
bd create --title="Task title" --type=task --priority=2

# With description from file
bd create --title="Task title" --type=task --body-file /tmp/description.md

# Epic with children
bd create --title="Epic title" --type=epic --priority=1

# Task under epic (child)
bd create --title="Child task" --type=task --parent=<epic-id>
```

### Update Issue

```bash
# Start work
bd update <id> --status=in_progress

# Assign
bd update <id> --assignee=username

# Add labels
bd label add <id> label1,label2
```

### Close Issue

```bash
bd close <id>                         # Simple close
bd close <id> --reason="Completed"    # With reason
bd close <id1> <id2> <id3>            # Multiple at once
```

### Dependencies

```bash
# Add dependency (child depends on parent, parent blocks child)
bd dep add <child-id> <parent-id>

# View blocked issues
bd blocked

# View what blocks an issue
bd show <id>                          # Dependencies shown in output
```

### Sync with Git

```bash
bd sync                               # Commit Beads changes to git
bd sync --status                      # Check sync status
```

## Priority Mapping

Beads uses numeric priorities (0-4):

- `0` or `P0` = Critical
- `1` or `P1` = High
- `2` or `P2` = Medium (default)
- `3` or `P3` = Low
- `4` or `P4` = Backlog

**Do NOT use string values** like "high", "medium", "low".

## Epic Workflow

### Create Epic Structure

```bash
# 1. Create epic
epic_id=$(bd create --title="Epic: Feature Name" --type=epic --priority=1 --silent)

# 2. Create child tasks
task1_id=$(bd create --title="Task 1" --type=task --parent="$epic_id" --silent)
task2_id=$(bd create --title="Task 2" --type=task --parent="$epic_id" --silent)

# 3. Add dependencies between tasks
bd dep add "$task2_id" "$task1_id"    # Task 2 depends on Task 1
```

### Check Epic Status

```bash
bd epic status                        # All epics with completion %
bd epic close-eligible                # Close completed epics
```

## ID Mapping

When migrating from GitHub issues or local sequential IDs:

```bash
# Store mapping in frontmatter
# Old: 001.md with github: https://github.com/repo/issues/123
# New: Store beads ID in frontmatter

# beads_id: reclux-a1b2c3
```

## Error Handling

If any bd command fails:

1. Show clear error: "❌ Beads operation failed: {command}"
2. Suggest fix based on error type:
   - "Not initialized" → "Run: bd init"
   - "Issue not found" → "Check issue ID with: bd list"
   - "Sync conflict" → "Run: bd sync --status"
3. Don't retry automatically

## Session Close Protocol

**CRITICAL:** Before completing any session:

```bash
# 1. Check git status
git status

# 2. Stage code changes
git add <files>

# 3. Sync Beads changes
bd sync

# 4. Commit code
git commit -m "..."

# 5. Sync again (captures any new Beads changes)
bd sync

# 6. Push to remote
git push
```

## Important Notes

- Trust that Beads is installed (check with `command -v bd`)
- Use `--silent` flag to get only the issue ID for scripting
- Use `--json` flag for structured output when parsing
- Keep operations atomic - one bd command per action
- Run `bd sync` at end of sessions to persist changes
- Issues stored locally in `.beads/` directory
- IDs are hash-based (e.g., `reclux-a1b2c3`) to prevent merge conflicts
