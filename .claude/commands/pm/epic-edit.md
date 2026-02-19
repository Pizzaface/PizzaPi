---
allowed-tools: Read, Write, LS
---

# Epic Edit

Edit epic details after creation.

## Usage

```
/pm:epic-edit <epic_name>
```

## Instructions

### 1. Read Current Epic

Read `.project/epics/$ARGUMENTS/epic.md`:

- Parse frontmatter
- Read content sections

### 2. Interactive Edit

Ask user what to edit:

- Name/Title
- Description/Overview
- Architecture decisions
- Technical approach
- Dependencies
- Success criteria

### 3. Update Epic File

Get current datetime: `date -u +"%Y-%m-%dT%H:%M:%SZ"`

Update epic.md:

- Preserve all frontmatter except `updated`
- Apply user's edits to content
- Update `updated` field with current datetime

### 4. Option to Update Beads

If epic has beads_id in frontmatter:
Ask: "Update Beads issue? (yes/no)"

If yes:

```bash
# Strip frontmatter and update Beads issue
sed '1,/^---$/d; 1,/^---$/d' .project/epics/$ARGUMENTS/epic.md > /tmp/epic-body.md
bd update {beads_id} --description-file /tmp/epic-body.md
bd sync
```

### 5. Output

```
✅ Updated epic: $ARGUMENTS
  Changes made to: {sections_edited}

{If Beads updated}: Beads issue updated ✅

View epic: /pm:epic-show $ARGUMENTS
```

## Important Notes

Preserve frontmatter history (created, beads_id, etc.).
Don't change task files when editing epic.
Follow the frontmatter-operations rule.
Follow the beads-operations rule for Beads commands.
