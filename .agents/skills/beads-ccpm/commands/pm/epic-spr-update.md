---
allowed-tools: Bash, Read, Write
---

# Epic SPR Update

Update stacked pull requests for an epic using SPR (Stacked Pull Requests).

## Usage

```
/pm:epic-spr-update <epic_name>
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

3. **Check for uncommitted changes:**
   ```bash
   cd ../epic-$ARGUMENTS && git status --porcelain
   ```
   If output is not empty: "❌ You have uncommitted changes. Commit them first."

## Instructions

### 1. Navigate to Worktree

```bash
cd ../epic-$ARGUMENTS
```

### 2. Squash Related Commits (Optional)

Before creating PRs, you may want to squash related commits into logical units:

```bash
# Check commit history
git log --oneline origin/main..HEAD

# Interactive rebase to squash commits
# Each squashed commit will become one PR in the stack
git rebase -i origin/main
```

### 3. Update SPR Stack

```bash
# This will:
# - Push commits to GitHub
# - Create/update PRs for each commit in the branch
# - Stack PRs on top of each other
git spr update

# With custom options:
# git spr update --message-template <template>
# git spr update --preserve-pr-title
```

### 4. Track PR Status

```bash
# List all PRs in the stack
git spr status

# Output will show:
# - PR numbers
# - Titles
# - Status (open/merged)
# - Stack order
```

### 5. Update Epic Documentation

Update `.project/epics/$ARGUMENTS/epic.md` frontmatter:

```yaml
---
spr_updated: {current_datetime}
pr_stack: [#123, #124, #125]  # List of PR numbers in order
---
```

### 6. Return to Main Repo

```bash
cd - > /dev/null
```

## Output Format

```
SPR Stack Updated: $ARGUMENTS

Worktree: ../epic-$ARGUMENTS
Branch: epic/$ARGUMENTS

Pull Requests Created/Updated:
  #123: Issue reclux-abc123: Database Schema (Base: main)
  #124: Issue reclux-def456: API Endpoints (Base: #123)
  #125: Issue reclux-ghi789: UI Components (Base: #124)

View stack: cd ../epic-$ARGUMENTS && git spr status
Merge ready PRs: /pm:epic-spr-merge $ARGUMENTS
```

## SPR Workflow Tips

### Squashing Commits Before SPR

Each commit in your branch becomes a separate PR. To create logical PR stacks:

```bash
# Squash commits by issue
# Before: 10 micro-commits for Issue A, 8 for Issue B
# After: 1 commit for Issue A, 1 for Issue B

git rebase -i origin/main
# In the editor, squash related commits together
# Each final commit = 1 PR in the stack
```

### Amending Commits in the Stack

```bash
# Make changes
git add <files>

# Amend any commit in the stack (SPR provides this)
git amend

# Update the stack
git spr update
```

### Merging the Stack

```bash
# Merge all mergeable PRs (bottom-up)
git spr merge

# Or merge specific PR and its dependencies
git spr merge --pr <number>
```

## Important Notes

- **Each commit = 1 PR**: Structure your commits carefully
- **Squash before SPR**: Combine related work into logical commits
- **SPR handles rebasing**: When base PRs merge, SPR updates dependent PRs
- **Worktree friendly**: SPR works great with worktrees for parallel epics
- Follow the worktree-operations rule for git operations

## Error Handling

If SPR update fails:

```
❌ SPR update failed: {error}

Common issues:
- Uncommitted changes: git status
- Merge conflicts: git rebase --abort
- Auth issues: gh auth login

Check SPR status: git spr status
View SPR logs: Check command output
```

If no commits to update:

```
No new commits found. Nothing to update.

Current stack: git spr status
Add commits: Work on issues and commit
```

## References

- [SPR Documentation](https://ejoffe.github.io/spr/)
- [SPR GitHub](https://github.com/ejoffe/spr)
- [Stacked PRs Workflow](https://www.stacking.dev/)
