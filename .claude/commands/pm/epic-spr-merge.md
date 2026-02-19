---
allowed-tools: Bash, Read, Write
---

# Epic SPR Merge

Merge stacked PRs for an epic using SPR (Stacked Pull Requests).

## Usage

```
/pm:epic-spr-merge <epic_name>
```

## Quick Check

1. **Verify worktree exists:**

   ```bash
   git worktree list | grep "epic-$ARGUMENTS" || echo "❌ No worktree for epic: $ARGUMENTS"
   ```

2. **Check if SPR is installed:**

   ```bash
   command -v git-spr >/dev/null 2>&1 || echo "❌ SPR not installed. Install: go install github.com/ejoffe/spr/cmd/spr@latest"
   ```

3. **Check PR status:**
   ```bash
   cd ../epic-$ARGUMENTS && git spr status
   ```

## Instructions

### 1. Navigate to Worktree

```bash
cd ../epic-$ARGUMENTS
```

### 2. Check Stack Status

```bash
# View current PR stack
git spr status

# Output shows:
# - Which PRs are mergeable
# - Which PRs are blocked
# - Review status
# - CI status
```

### 3. Merge Ready PRs

```bash
# Merge all mergeable PRs in the stack (bottom-up)
# SPR will:
# - Merge the bottom PR first
# - Update dependent PRs to new base
# - Continue merging up the stack
git spr merge

# Or merge specific PR with its dependencies
# git spr merge --pr <number>

# Or merge with custom options
# git spr merge --keep-branch  # Don't delete branch after merge
```

### 4. Handle Blocked PRs

If some PRs can't merge:

```bash
# Check why PRs are blocked
git spr status

# Common blocks:
# - Failing CI checks
# - Pending reviews
# - Merge conflicts
# - Not approved

# Address issues on GitHub, then retry
```

### 5. Verify Merge Status

```bash
# Check what merged
git spr status

# Fetch latest main
git fetch origin main

# View merged commits in main
git log --oneline origin/main~10..origin/main
```

### 6. Update Epic Documentation

Get current datetime: `date -u +"%Y-%m-%dT%H:%M:%SZ"`

Update `.project/epics/$ARGUMENTS/epic.md`:

```yaml
---
status: completed
completed: {current_datetime}
merged_prs: [#123, #124, #125]
---
```

### 7. Clean Up If Fully Merged

If all PRs merged successfully:

```bash
# Return to main repo
cd {main-repo-path}

# Update main branch
git checkout main
git pull origin main

# Remove worktree
git worktree remove ../epic-$ARGUMENTS
echo "Worktree removed: ../epic-$ARGUMENTS"

# Branch is already deleted by SPR merge

# Archive epic
mkdir -p .project/epics/archived/
mv .project/epics/$ARGUMENTS .project/epics/archived/
echo "Epic archived: .project/epics/archived/$ARGUMENTS"
```

### 8. Update Beads Issues

```bash
# Get epic Beads ID
epic_id=$(grep '^beads_id:' .project/epics/archived/$ARGUMENTS/epic.md | sed 's/^beads_id: *//')

# Close epic issue
if [ -n "$epic_id" ]; then
  bd close "$epic_id" --reason="Epic completed - all PRs merged"
fi

# Close task issues
for task_file in .project/epics/archived/$ARGUMENTS/*.md; do
  [ -f "$task_file" ] || continue
  [ "$(basename $task_file)" = "epic.md" ] && continue
  [ "$(basename $task_file)" = "beads-mapping.md" ] && continue

  task_id=$(grep '^beads_id:' "$task_file" | sed 's/^beads_id: *//')
  if [ -n "$task_id" ]; then
    bd close "$task_id" --reason="Completed - PR merged"
  fi
done

# Sync all changes
bd sync
```

## Output Format

### Successful Merge

```
Epic PRs Merged Successfully: $ARGUMENTS

Merged PRs:
  ✅ #123: Issue reclux-abc123: Database Schema
  ✅ #124: Issue reclux-def456: API Endpoints
  ✅ #125: Issue reclux-ghi789: UI Components

Summary:
  Total PRs: 3
  Merged: 3
  Commits to main: 3

Cleanup completed:
  - Worktree removed
  - Branch deleted (by SPR)
  - Epic archived
  - Beads issues closed

View merged commits: git log --oneline origin/main~3..origin/main
```

### Partial Merge

```
Epic PRs Partially Merged: $ARGUMENTS

Merged:
  ✅ #123: Issue reclux-abc123: Database Schema

Blocked:
  ⏸ #124: Issue reclux-def456: API Endpoints (CI failing)
  ⏸ #125: Issue reclux-ghi789: UI Components (depends on #124)

Next steps:
  1. Fix CI for #124
  2. Re-run: /pm:epic-spr-merge $ARGUMENTS

Worktree preserved: ../epic-$ARGUMENTS
```

## SPR Merge Behavior

### Bottom-Up Merging

SPR merges PRs from bottom to top of the stack:

```
Stack:           Merge Order:
#125 (top)       3. Merge #125 (after #124 merges)
  ↑
#124             2. Merge #124 (after #123 merges)
  ↑
#123 (base)      1. Merge #123 first
```

### Automatic Rebase

When a PR merges, SPR automatically:

- Rebases dependent PRs on the new main
- Updates PR branches
- Maintains the stack structure

### Squash Merge Compatible

SPR handles GitHub's squash merge:

- Creates new commit hash
- Updates dependent PRs to reference new hash
- Maintains stack integrity

## Error Handling

If merge fails:

```
❌ Merge failed: {error}

Common issues:
- PR not approved: Get reviews on GitHub
- CI failing: Fix tests and wait for CI
- Merge conflicts: Rebase on latest main
- Not mergeable: Check PR requirements

Check status: cd ../epic-$ARGUMENTS && git spr status
View PR: gh pr view <number>
```

If no PRs are mergeable:

```
No PRs ready to merge.

Blocked PRs:
  #123: Waiting for CI
  #124: Needs approval
  #125: Depends on #124

Next: Address blockers on GitHub
Monitor: /pm:epic-status $ARGUMENTS
```

## Important Notes

- **SPR handles complexity**: Automatic rebasing and stack updates
- **Squash-merge safe**: SPR manages new commit hashes
- **Worktree friendly**: Keep worktree until all PRs merge
- **Partial merges OK**: Bottom PRs can merge while top ones wait
- Follow the worktree-operations rule for git operations
- Follow the beads-operations rule for Beads commands

## References

- [SPR Documentation](https://ejoffe.github.io/spr/)
- [SPR GitHub](https://github.com/ejoffe/spr)
- [Stacked PRs with Squash Merge](https://echobind.com/post/stacked-pull-requests-with-squash-merge)
