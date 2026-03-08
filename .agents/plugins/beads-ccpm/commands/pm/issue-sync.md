---
allowed-tools: Bash, Read, Write, LS
---

# Issue Sync

Sync local progress updates to Beads for transparent audit trail.

## Usage

```
/pm:issue-sync <beads_id>
```

## Required Rules

**IMPORTANT:** Before executing this command, read and follow:

- the datetime rule - For getting real current date/time
- the beads-operations rule - For Beads CLI operations

## Preflight Checklist

Before proceeding, complete these validation steps.
Do not bother the user with preflight checks progress. Just do them and move on.

0. **Beads Initialization Check:**
   Follow the beads-operations rule - check Beads is initialized:

   ```bash
   if [ ! -d ".beads" ]; then
     echo "❌ ERROR: Beads not initialized. Run: bd init"
     exit 1
   fi
   ```

1. **Issue Validation:**
   - Run: `bd show $ARGUMENTS --json`
   - If issue doesn't exist, tell user: "❌ Issue $ARGUMENTS not found"
   - If issue is closed and completion < 100%, warn: "Issue is closed but work incomplete"

2. **Local Updates Check:**
   - Check if `.project/epics/*/updates/$ARGUMENTS/` directory exists
   - If not found, tell user: "❌ No local updates found for issue $ARGUMENTS. Run: /pm:issue-start $ARGUMENTS"
   - Check if progress.md exists
   - If not, tell user: "❌ No progress tracking found. Initialize with: /pm:issue-start $ARGUMENTS"

3. **Check Last Sync:**
   - Read `last_sync` from progress.md frontmatter
   - If synced recently (< 5 minutes), ask: "Recently synced. Force sync anyway? (yes/no)"
   - Calculate what's new since last sync

4. **Verify Changes:**
   - Check if there are actual updates to sync
   - If no changes, tell user: "No new updates to sync since {last_sync}"
   - Exit gracefully if nothing to sync

## Instructions

You are synchronizing local development progress to Beads for: **Issue $ARGUMENTS**

### 1. Gather Local Updates

Collect all local updates for the issue:

- Read from `.project/epics/{epic_name}/updates/$ARGUMENTS/`
- Check for new content in:
  - `progress.md` - Development progress
  - `notes.md` - Technical notes and decisions
  - `commits.md` - Recent commits and changes
  - Any other update files

### 2. Update Progress Tracking Frontmatter

Get current datetime: `date -u +"%Y-%m-%dT%H:%M:%SZ"`

Update the progress.md file frontmatter:

```yaml
---
issue: $ARGUMENTS
started: [preserve existing date]
last_sync: [Use REAL datetime from command above]
completion: [calculated percentage 0-100%]
---
```

### 3. Determine What's New

Compare against previous sync to identify new content:

- Look for sync timestamp markers
- Identify new sections or updates
- Gather only incremental changes since last sync

### 4. Format Update Comment

Create comprehensive update for Beads comment:

```markdown
## Progress Update - {current_date}

### Completed Work

{list_completed_items}

### In Progress

{current_work_items}

### Technical Notes

{key_technical_decisions}

### Acceptance Criteria Status

- [x] {completed_criterion}
- [ ] {in_progress_criterion}
- [ ] {pending_criterion}

### Next Steps

{planned_next_actions}

### Blockers

{any_current_blockers}

### Recent Commits

{commit_summaries}

---

_Progress: {completion}% | Synced at {timestamp}_
```

### 5. Post to Beads

Use Beads CLI to add comment:

```bash
# Create temp file with comment content
cat > /tmp/beads-comment.md << 'EOF'
{formatted_comment_content}
EOF

# Add comment to issue
bd comments add $ARGUMENTS --body-file /tmp/beads-comment.md

# Clean up
rm /tmp/beads-comment.md
```

### 6. Update Local Task File

Get current datetime: `date -u +"%Y-%m-%dT%H:%M:%SZ"`

Update the task file frontmatter with sync information:

```yaml
---
name: [Task Title]
status: open
created: [preserve existing date]
updated: [Use REAL datetime from command above]
beads_id: $ARGUMENTS
---
```

### 7. Handle Completion

If task is complete, update all relevant frontmatter:

**Task file frontmatter**:

```yaml
---
name: [Task Title]
status: closed
created: [existing date]
updated: [current date/time]
beads_id: $ARGUMENTS
---
```

**Progress file frontmatter**:

```yaml
---
issue: $ARGUMENTS
started: [existing date]
last_sync: [current date/time]
completion: 100%
---
```

**Epic progress update**: Recalculate epic progress based on completed tasks and update epic frontmatter:

```yaml
---
name: [Epic Name]
status: in-progress
created: [existing date]
progress: [calculated percentage based on completed tasks]%
prd: [existing path]
beads_id: [existing ID]
---
```

### 8. Completion Comment

If task is complete:

```markdown
## Task Completed - {current_date}

### All Acceptance Criteria Met

- [x] {criterion_1}
- [x] {criterion_2}
- [x] {criterion_3}

### Deliverables

- {deliverable_1}
- {deliverable_2}

### Testing

- Unit tests: Passing
- Integration tests: Passing
- Manual testing: Complete

### Documentation

- Code documentation: Updated
- README updates: Complete

This task is ready for review and can be closed.

---

_Task completed: 100% | Synced at {timestamp}_
```

### 9. Sync Beads

```bash
bd sync
```

### 10. Output Summary

```
Synced updates to Beads Issue $ARGUMENTS

Update summary:
   Progress items: {progress_count}
   Technical notes: {notes_count}
   Commits referenced: {commit_count}

Current status:
   Task completion: {task_completion}%
   Epic progress: {epic_progress}%
   Completed criteria: {completed}/{total}

View update: bd show $ARGUMENTS
```

### 11. Frontmatter Maintenance

- Always update task file frontmatter with current timestamp
- Track completion percentages in progress files
- Update epic progress when tasks complete
- Maintain sync timestamps for audit trail

### 12. Incremental Sync Detection

**Prevent Duplicate Comments:**

1. Add sync markers to local files after each sync:
   ```markdown
   <!-- SYNCED: 2024-01-15T10:30:00Z -->
   ```
2. Only sync content added after the last marker
3. If no new content, skip sync with message: "No updates since last sync"

### 13. Error Handling

**Common Issues and Recovery:**

1. **Issue Not Found:**
   - Message: "❌ Issue $ARGUMENTS not found in Beads"
   - Solution: "Verify issue ID with: bd list"
   - Check if issue was created with different ID

2. **Sync Conflict:**
   - Message: "❌ Beads sync conflict"
   - Solution: "Run: bd sync --status to check"
   - May need to resolve conflicts manually

3. **Comment Too Large:**
   - Message: "Update too large"
   - Solution: Split into multiple comments or summarize
   - Warn user: "Update truncated. Full details in local files."

### 14. Epic Progress Calculation

When updating epic progress:

1. Count total tasks in epic directory
2. Count tasks with `status: closed` in frontmatter
3. Calculate: `progress = (closed_tasks / total_tasks) * 100`
4. Round to nearest integer
5. Update epic frontmatter only if percentage changed

### 15. Post-Sync Validation

After successful sync:

- [ ] Verify comment added to Beads issue
- [ ] Confirm frontmatter updated with sync timestamp
- [ ] Check epic progress updated if task completed
- [ ] Validate no data corruption in local files
- [ ] Run `bd sync` to persist changes

This creates a transparent audit trail of development progress that can be tracked in Beads for Issue $ARGUMENTS, while maintaining accurate frontmatter across all project files.
