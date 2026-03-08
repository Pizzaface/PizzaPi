---
allowed-tools: Bash, Read, Write, LS
---

# Sync

Full bidirectional sync between local files and Beads.

## Usage

```
/pm:sync [epic_name]
```

If epic_name provided, sync only that epic. Otherwise sync all.

## Instructions

### 1. Sync Beads with Git

First ensure Beads is synced with the git remote:

```bash
# Check sync status
bd sync --status

# Pull latest changes
bd sync
```

### 2. Update Local from Beads

For each Beads issue:

- Find corresponding local file by Beads ID
- Compare states:
  - If Beads state newer (updated_at > local updated), update local
  - If Beads closed but local open, close local
  - If Beads reopened but local closed, reopen local
- Update frontmatter to match Beads state

```bash
# Get all issues
bd list --json > /tmp/beads-issues.json

# Process each issue and update local files
```

### 3. Push Local to Beads

For each local task/epic:

- If has Beads ID but issue not found, it was deleted - mark local as archived
- If no Beads ID, create new issue (like epic-sync)
- If local updated > Beads updated_at, push changes:
  ```bash
  bd update {beads_id} --description-file {local_file}
  ```

### 4. Handle Conflicts

If both changed (local and Beads updated since last sync):

- Show both versions
- Ask user: "Local and Beads both changed. Keep: (local/beads/merge)?"
- Apply user's choice

### 5. Update Sync Timestamps

Update all synced files with last_sync timestamp.

### 6. Final Beads Sync

```bash
bd sync
```

### 7. Output

```
Sync Complete

Pulled from Beads:
  Updated: {count} files
  Closed: {count} issues

Pushed to Beads:
  Updated: {count} issues
  Created: {count} new issues

Conflicts resolved: {count}

Status:
  All files synced
  {or list any sync failures}
```

## Important Notes

Follow the beads-operations rule for Beads commands.
Follow the frontmatter-operations rule for local updates.
Always backup before sync in case of issues.
