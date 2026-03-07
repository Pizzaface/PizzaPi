---
allowed-tools: Bash, Read, Write, LS
---

# Issue Edit

Edit issue details locally and in Beads.

## Usage

```
/pm:issue-edit <beads_id>
```

## Instructions

### 1. Get Current Issue State

```bash
# Get from Beads
bd show $ARGUMENTS --json

# Find local task file
# Search for file with beads_id: $ARGUMENTS
```

### 2. Interactive Edit

Ask user what to edit:

- Title
- Description/Body
- Labels
- Priority
- Acceptance criteria (local only)

### 3. Update Local File

Get current datetime: `date -u +"%Y-%m-%dT%H:%M:%SZ"`

Update task file with changes:

- Update frontmatter `name` if title changed
- Update body content if description changed
- Update `updated` field with current datetime

### 4. Update Beads

If title changed:

```bash
bd update $ARGUMENTS --title "{new_title}"
```

If description changed:

```bash
bd update $ARGUMENTS --description-file {updated_task_file}
```

If labels changed:

```bash
bd label add $ARGUMENTS {new_labels}
bd label remove $ARGUMENTS {removed_labels}
```

If priority changed:

```bash
bd update $ARGUMENTS --priority={new_priority}
```

### 5. Sync Beads

```bash
bd sync
```

### 6. Output

```
Updated issue $ARGUMENTS
  Changes:
    {list_of_changes_made}

Synced to Beads: Done
```

## Important Notes

Always update local first, then Beads.
Preserve frontmatter fields not being edited.
Follow the frontmatter-operations rule.
Follow the beads-operations rule for Beads commands.
