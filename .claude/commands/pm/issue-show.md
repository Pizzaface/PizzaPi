---
allowed-tools: Bash, Read, LS
---

# Issue Show

Display issue and sub-issues with detailed information.

## Usage

```
/pm:issue-show <beads_id>
```

## Instructions

You are displaying comprehensive information about a Beads issue and related sub-issues for: **Issue $ARGUMENTS**

### 1. Fetch Issue Data

- Use `bd show $ARGUMENTS` to get Beads issue details
- Look for local task file: first check `.project/epics/*/$ARGUMENTS.md` (new naming)
- If not found, search for file with `beads_id: $ARGUMENTS` in frontmatter
- Check for related issues and sub-tasks

### 2. Issue Overview

Display issue header:

```
Issue $ARGUMENTS: {Issue Title}
   Status: {open/closed/in_progress}
   Labels: {labels}
   Assignee: {assignee}
   Priority: {priority}
   Created: {creation_date}
   Updated: {last_update}

Description:
{issue_description}
```

### 3. Local File Mapping

If local task file exists:

```
Local Files:
   Task file: .project/epics/{epic_name}/{task_file}
   Updates: .project/epics/{epic_name}/updates/$ARGUMENTS/
   Last local update: {timestamp}
```

### 4. Dependencies

Show related issues:

```
Dependencies:
   Parent Epic: {epic_id}
   Depends On: {dep1}, {dep2}
   Blocking: {blocked1}, {blocked2}
   Children: {child1}, {child2}
```

Use Beads to get dependency info:

```bash
bd show $ARGUMENTS --json | jq '.dependencies, .blocked_by'
```

### 5. Comments/Activity

Display recent comments:

```
Recent Activity:
   {timestamp} - {author}: {comment_preview}
   {timestamp} - {author}: {comment_preview}

View full details: bd show $ARGUMENTS
```

### 6. Progress Tracking

If task file exists, show progress:

```
Acceptance Criteria:
   [x] Criterion 1 (completed)
   [ ] Criterion 2 (in progress)
   [ ] Criterion 3 (blocked)
   [ ] Criterion 4 (not started)
```

### 7. Quick Actions

```
Quick Actions:
   Start work: /pm:issue-start $ARGUMENTS
   Sync updates: /pm:issue-sync $ARGUMENTS
   Add comment: bd comments add $ARGUMENTS --body "your comment"
   Close issue: bd close $ARGUMENTS
```

### 8. Error Handling

- Handle invalid issue IDs gracefully
- Check if Beads is initialized
- Provide helpful error messages and alternatives

Provide comprehensive issue information to help developers understand context and current status for Issue $ARGUMENTS.
