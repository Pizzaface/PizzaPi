---
allowed-tools: Read, LS
---

# Epic Oneshot

Decompose epic into tasks and sync to Beads in one operation.

## Usage

```
/pm:epic-oneshot <feature_name>
```

## Instructions

### 1. Validate Prerequisites

Check that epic exists and hasn't been processed:

```bash
# Epic must exist
test -f .project/epics/$ARGUMENTS/epic.md || echo "❌ Epic not found. Run: /pm:prd-parse $ARGUMENTS"

# Check for existing tasks
if ls .project/epics/$ARGUMENTS/[0-9]*.md 2>/dev/null | grep -q .; then
  echo "⚠️ Tasks already exist. This will create duplicates."
  echo "Delete existing tasks or use /pm:epic-sync instead."
  exit 1
fi

# Check if already synced
if grep -q "beads_id:" .project/epics/$ARGUMENTS/epic.md; then
  echo "⚠️ Epic already synced to Beads."
  echo "Use /pm:epic-sync to update."
  exit 1
fi
```

### 2. Execute Decompose

Simply run the decompose command:

```
Running: /pm:epic-decompose $ARGUMENTS
```

This will:

- Read the epic
- Create task files (using parallel agents if appropriate)
- Update epic with task summary

### 3. Execute Sync

Immediately follow with sync:

```
Running: /pm:epic-sync $ARGUMENTS
```

This will:

- Create epic issue in Beads
- Create child tasks (using parallel agents if appropriate)
- Rename task files to Beads IDs
- Create worktree

### 4. Output

```
🚀 Epic Oneshot Complete: $ARGUMENTS

Step 1: Decomposition ✓
  - Tasks created: {count}

Step 2: Beads Sync ✓
  - Epic: {beads_id}
  - Child tasks created: {count}
  - Worktree: ../epic-$ARGUMENTS

Ready for development!
  Start work: /pm:epic-start $ARGUMENTS
  Or single task: /pm:issue-start {beads_id}
```

## Important Notes

This is simply a convenience wrapper that runs:

1. `/pm:epic-decompose`
2. `/pm:epic-sync`

Both commands handle their own error checking, parallel execution, and validation. This command just orchestrates them in sequence.

Use this when you're confident the epic is ready and want to go from epic to Beads issues in one step.
