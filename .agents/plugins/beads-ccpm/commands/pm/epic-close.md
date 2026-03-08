---
allowed-tools: Bash, Read, Write, LS
---

# Epic Close

Mark an epic as complete when all tasks are done.

## Usage

```
/pm:epic-close <epic_name>
```

## Instructions

### 1. Verify All Tasks Complete

Check all task files in `.project/epics/$ARGUMENTS/`:

- Verify all have `status: closed` in frontmatter
- If any open tasks found: "❌ Cannot close epic. Open tasks remain: {list}"

### 2. Update Epic Status

Get current datetime: `date -u +"%Y-%m-%dT%H:%M:%SZ"`

Update epic.md frontmatter:

```yaml
status: completed
progress: 100%
updated: { current_datetime }
completed: { current_datetime }
```

### 3. Update PRD Status

If epic references a PRD, update its status to "complete".

### 4. Check for SPR Stack

If working with SPR, check if all PRs are merged:

```bash
# Check if worktree exists
if git worktree list | grep -q "epic-$ARGUMENTS"; then
  echo "
  ⚠️  SPR Workflow Check:

  If using stacked PRs, ensure all PRs are merged:
  1. cd ../epic-$ARGUMENTS
  2. git spr status
  3. If PRs pending: /pm:epic-spr-merge $ARGUMENTS

  Or use traditional merge: /pm:epic-merge $ARGUMENTS
  "
fi

# Check if branch exists
if git branch -a | grep -q "epic/$ARGUMENTS"; then
  echo "
  ⚠️  Branch still exists: epic/$ARGUMENTS

  If using SPR and PRs are merged:
    - Worktree/branch cleanup happens in epic-spr-merge

  If using traditional workflow:
    - Run /pm:epic-merge $ARGUMENTS first
  "
fi
```

### 5. Close Epic in Beads

If epic has Beads ID:

```bash
# Get epic Beads ID
epic_id=$(grep '^beads_id:' .project/epics/$ARGUMENTS/epic.md | sed 's/^beads_id: *//')

if [ -n "$epic_id" ]; then
  # Close the epic in Beads
  bd close "$epic_id" --reason="Epic completed - all tasks done"

  # Sync changes
  bd sync
fi
```

### 6. Archive Option

Ask user: "Archive completed epic? (yes/no)"

If yes:

- Move epic directory to `.project/epics/.archived/{epic_name}/`
- Create archive summary with completion date

### 7. Output

```
Epic closed: $ARGUMENTS
  Tasks completed: {count}
  Duration: {days_from_created_to_completed}

{If archived}: Archived to .project/epics/.archived/

Next epic: Run /pm:next to see priority work
          or: bd ready to see available work
```

## Important Notes

Only close epics with all tasks complete.
Preserve all data when archiving.
Update related PRD status.
Follow the beads-operations rule for Beads commands.
