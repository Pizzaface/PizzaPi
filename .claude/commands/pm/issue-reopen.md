---
allowed-tools: Bash, Read, Write, LS
---

# Issue Reopen

Reopen a closed issue.

## Usage

```
/pm:issue-reopen <beads_id> [reason]
```

## Instructions

### 1. Find Local Task File

Search for task file with `beads_id: $ARGUMENTS` in frontmatter.
If not found, check if `.project/epics/*/$ARGUMENTS.md` exists.
If not found: "❌ No local task for issue $ARGUMENTS"

### 2. Update Local Status

Get current datetime: `date -u +"%Y-%m-%dT%H:%M:%SZ"`

Update task file frontmatter:

```yaml
status: open
updated: { current_datetime }
```

### 3. Reset Progress

If progress file exists:

- Keep original started date
- Reset completion to previous value or 0%
- Add note about reopening with reason

### 4. Reopen in Beads

```bash
# Reopen the issue
bd reopen $ARGUMENTS

# Add comment with reason if provided
if [ -n "$reason" ]; then
  echo "Reopening issue

Reason: $reason

---
Reopened at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")" | bd comments add $ARGUMENTS --body-file -
fi

# Sync changes
bd sync
```

### 5. Update Epic Progress

Recalculate epic progress with this task now open again.

### 6. Output

```
Reopened issue $ARGUMENTS
  Reason: {reason_if_provided}
  Epic progress: {updated_progress}%

Start work with: /pm:issue-start $ARGUMENTS
```

## Important Notes

Preserve work history in progress files.
Don't delete previous progress, just reset status.
Follow the beads-operations rule for Beads commands.
