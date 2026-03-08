---
allowed-tools: Bash, Read, Write, LS
---

# Issue Close

Mark an issue as complete and close it in Beads.

## Usage

```
/pm:issue-close <beads_id> [completion_notes]
```

## Instructions

### 1. Find Local Task File

First check if `.project/epics/*/$ARGUMENTS.md` exists (new naming with Beads ID).
If not found, search for task file with `beads_id: $ARGUMENTS` in frontmatter.
If not found: "❌ No local task for issue $ARGUMENTS"

### 2. Update Local Status

Get current datetime: `date -u +"%Y-%m-%dT%H:%M:%SZ"`

Update task file frontmatter:

```yaml
status: closed
updated: { current_datetime }
```

### 3. Update Progress File

If progress file exists at `.project/epics/{epic}/updates/$ARGUMENTS/progress.md`:

- Set completion: 100%
- Add completion note with timestamp
- Update last_sync with current datetime

### 4. Squash Commits (For SPR Workflow)

If working in an epic worktree and using SPR, squash related commits:

```bash
# Check if in epic worktree
if git worktree list | grep -q "epic-"; then
  echo "
  ⚠️  SPR Workflow Reminder:

  Before closing, consider squashing commits for this issue:
  1. cd ../epic-{name}
  2. git log --oneline origin/main..HEAD
  3. git rebase -i origin/main
  4. Squash commits for $ARGUMENTS into one logical commit
  5. Force push: git push -f

  Each squashed commit = 1 PR in stacked PR workflow.

  Skip if commits are already squashed or using traditional workflow.
  "
fi
```

### 5. Close in Beads

Add completion comment and close:

```bash
# Add final comment if completion notes provided
if [ -n "$completion_notes" ]; then
  echo "Task completed: $completion_notes" | bd comments add $ARGUMENTS --body-file -
fi

# Close the issue
bd close $ARGUMENTS --reason="Task completed"
```

### 6. Update Epic Task List

Check off the task in the epic's local tracking:

```bash
# Get epic name from local task file path
epic_name={extract_from_path}

# Get epic Beads ID from epic.md
epic_id=$(grep '^beads_id:' .project/epics/$epic_name/epic.md | sed 's/^beads_id: *//')

if [ -n "$epic_id" ]; then
  # Update local epic.md to mark task complete
  sed -i.bak "s/- \[ \] $ARGUMENTS/- [x] $ARGUMENTS/" .project/epics/$epic_name/epic.md
  rm .project/epics/$epic_name/epic.md.bak

  echo "Updated epic progress locally"
fi
```

### 7. Update Epic Progress

- Count total tasks in epic
- Count closed tasks
- Calculate new progress percentage
- Update epic.md frontmatter progress field

```bash
# Calculate progress
total_tasks=$(ls .project/epics/$epic_name/*.md 2>/dev/null | grep -v epic.md | grep -v beads-mapping.md | wc -l)
closed_tasks=$(grep -l '^status: closed' .project/epics/$epic_name/*.md 2>/dev/null | wc -l)
progress=$((closed_tasks * 100 / total_tasks))

# Update epic frontmatter
current_date=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
sed -i.bak "/^progress:/c\progress: ${progress}%" .project/epics/$epic_name/epic.md
sed -i.bak "/^updated:/c\updated: $current_date" .project/epics/$epic_name/epic.md
rm .project/epics/$epic_name/epic.md.bak
```

### 8. Check Epic Completion

If all tasks are closed, notify about epic completion:

```bash
if [ "$progress" -eq 100 ]; then
  echo "All tasks complete! Consider closing the epic:"
  echo "  bd epic close-eligible"
  echo "  or: /pm:epic-close $epic_name"
fi
```

### 9. Sync Beads

```bash
bd sync
```

### 10. Output

```
Closed issue $ARGUMENTS
  Local: Task marked complete
  Beads: Issue closed
  Epic progress: {new_progress}% ({closed}/{total} tasks complete)

Next: Run /pm:next for next priority task
      or: bd ready to see available work
```

## Important Notes

Follow the frontmatter-operations rule for updates.
Follow the beads-operations rule for Beads commands.
Always sync local state before closing in Beads.
