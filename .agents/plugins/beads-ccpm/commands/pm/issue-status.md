---
allowed-tools: Bash, Read, LS
---

# Issue Status

Check issue status and current state.

## Usage

```
/pm:issue-status <beads_id>
```

## Instructions

You are checking the current status of a Beads issue and providing a quick status report for: **Issue $ARGUMENTS**

### 1. Fetch Issue Status

Use Beads CLI to get current status:

```bash
bd show $ARGUMENTS --json
```

### 2. Status Display

Show concise status information:

```
Issue $ARGUMENTS: {Title}

Status: {open/closed/in_progress}
   Priority: {priority}
   Last update: {timestamp}
   Assignee: {assignee or "Unassigned"}

Labels: {label1}, {label2}, {label3}
```

### 3. Epic Context

If issue is part of an epic:

```
Epic Context:
   Epic: {epic_name}
   Epic progress: {completed_tasks}/{total_tasks} tasks complete
   This task: {task_position} of {total_tasks}
```

### 4. Dependencies

Show blocking status:

```
Dependencies:
   Depends on: {dep1}, {dep2}
   Blocking: {blocked1}, {blocked2}
   Status: {ready/blocked}
```

Use:

```bash
bd show $ARGUMENTS --json | jq '.dependencies, .blocked_by'
```

### 5. Local Sync Status

Check if local files are in sync:

```
Local Sync:
   Local file: {exists/missing}
   Last local update: {timestamp}
   Sync status: {in_sync/needs_sync/local_ahead/beads_ahead}
```

### 6. Quick Status Indicators

Use clear visual indicators:

- Ready: Open and no blockers
- Blocked: Open with unmet dependencies
- In Progress: Being worked on
- Complete: Closed and done

### 7. Actionable Next Steps

Based on status, suggest actions:

```
Suggested Actions:
   - Start work: /pm:issue-start $ARGUMENTS
   - Sync updates: /pm:issue-sync $ARGUMENTS
   - Close issue: bd close $ARGUMENTS
   - Reopen issue: bd reopen $ARGUMENTS
   - View details: bd show $ARGUMENTS
```

### 8. Batch Status

If checking multiple issues, support comma-separated list:

```
/pm:issue-status id1,id2,id3
```

Keep the output concise but informative, perfect for quick status checks during development of Issue $ARGUMENTS.
