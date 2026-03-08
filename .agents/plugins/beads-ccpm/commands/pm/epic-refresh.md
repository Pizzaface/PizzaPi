---
allowed-tools: Read, Write, LS
---

# Epic Refresh

Update epic progress based on task states.

## Usage

```
/pm:epic-refresh <epic_name>
```

## Instructions

### 1. Count Task Status

Scan all task files in `.project/epics/$ARGUMENTS/`:

- Count total tasks
- Count tasks with `status: closed`
- Count tasks with `status: open`
- Count tasks with work in progress

### 2. Calculate Progress

```
progress = (closed_tasks / total_tasks) * 100
```

Round to nearest integer.

### 3. Update Beads Task List

If epic has beads_id, sync task status:

```bash
# Get epic beads_id from epic.md frontmatter
epic_beads_id={extract_from_beads_id_field}

if [ ! -z "$epic_beads_id" ]; then
  # For each task, check its status
  for task_file in .project/epics/$ARGUMENTS/*.md; do
    [ "$(basename $task_file)" = "epic.md" ] && continue
    [ "$(basename $task_file)" = "beads-mapping.md" ] && continue

    # Extract task beads_id
    task_beads_id=$(grep 'beads_id:' "$task_file" 2>/dev/null | sed 's/^beads_id: *//' || true)
    task_status=$(grep 'status:' $task_file | cut -d: -f2 | tr -d ' ')

    if [ "$task_status" = "closed" ] && [ -n "$task_beads_id" ]; then
      # Close task in Beads if not already closed
      bd close "$task_beads_id" --reason="Task completed" 2>/dev/null || true
    fi
  done

  # Sync changes
  bd sync
fi
```

### 4. Determine Epic Status

- If progress = 0% and no work started: `backlog`
- If progress > 0% and < 100%: `in-progress`
- If progress = 100%: `completed`

### 5. Update Epic

Get current datetime: `date -u +"%Y-%m-%dT%H:%M:%SZ"`

Update epic.md frontmatter:

```yaml
status: {calculated_status}
progress: {calculated_progress}%
updated: {current_datetime}
```

### 6. Output

```
🔄 Epic refreshed: $ARGUMENTS

Tasks:
  Closed: {closed_count}
  Open: {open_count}
  Total: {total_count}

Progress: {old_progress}% → {new_progress}%
Status: {old_status} → {new_status}
Beads: Task list updated ✓

{If complete}: Run /pm:epic-close $ARGUMENTS to close epic
{If in progress}: Run /pm:next to see priority tasks
```

## Important Notes

This is useful after manual task edits or Beads sync.
Don't modify task files, only epic status.
Preserve all other frontmatter fields.
Follow the beads-operations rule for Beads commands.
