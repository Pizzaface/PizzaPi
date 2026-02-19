---
allowed-tools: Bash, Read, Write, LS, Task
---

# Epic Start

Launch parallel agents to work on epic tasks in a shared worktree.

## Usage

```
/pm:epic-start <epic_name>
```

## Quick Check

1. **Verify epic exists:**

   ```bash
   test -f .project/epics/$ARGUMENTS/epic.md || echo "❌ Epic not found. Run: /pm:prd-parse $ARGUMENTS"
   ```

2. **Check Beads sync:**
   Look for `beads_id:` field in epic frontmatter.
   If missing: "❌ Epic not synced. Run: /pm:epic-sync $ARGUMENTS first"

3. **Check for worktree:**
   ```bash
   git worktree list | grep "epic-$ARGUMENTS"
   ```

## Instructions

### 1. Create or Enter Worktree

Follow the worktree-operations rule:

```bash
# If worktree doesn't exist, create it
if ! git worktree list | grep -q "epic-$ARGUMENTS"; then
  git checkout main
  git pull origin main
  git worktree add ../epic-$ARGUMENTS -b epic/$ARGUMENTS
  echo "✅ Created worktree: ../epic-$ARGUMENTS"
else
  echo "✅ Using existing worktree: ../epic-$ARGUMENTS"
fi
```

### 2. Identify Ready Issues

Read all task files in `.project/epics/$ARGUMENTS/`:

- Parse frontmatter for `status`, `depends_on`, `parallel` fields
- Check Beads task status if needed
- Build dependency graph

Categorize issues:

- **Ready**: No unmet dependencies, not started
- **Blocked**: Has unmet dependencies
- **In Progress**: Already being worked on
- **Complete**: Finished

### 3. Analyze Ready Issues

For each ready issue without analysis:

```bash
# Check for analysis
if ! test -f .project/epics/$ARGUMENTS/{issue}-analysis.md; then
  echo "Analyzing issue #{issue}..."
  # Run analysis (inline or via Task tool)
fi
```

### 4. Launch Parallel Agents

For each ready issue with analysis:

```markdown
## Starting Issue {beads_id}: {title}

Reading analysis...
Found {count} parallel streams:

- Stream A: {description} (Agent-{id})
- Stream B: {description} (Agent-{id})

Launching agents in worktree: ../epic-$ARGUMENTS/
```

Use Task tool to launch each stream:

```yaml
Task:
  description: 'Issue {beads_id} Stream {X}'
  subagent_type: '{agent_type}'
  prompt: |
    Working in worktree: ../epic-$ARGUMENTS/
    Issue: {beads_id} - {title}
    Stream: {stream_name}

    Your scope:
    - Files: {file_patterns}
    - Work: {stream_description}

    Read full requirements from:
    - .project/epics/$ARGUMENTS/{task_file}
    - .project/epics/$ARGUMENTS/{beads_id}-analysis.md

    Follow coordination rules in /rules/agent-coordination.md

    Commit frequently with message format:
    "Issue {beads_id}: {specific change}"

    Update progress in:
    .project/epics/$ARGUMENTS/updates/{beads_id}/stream-{X}.md
```

### 5. Track Active Agents

Create/update `.project/epics/$ARGUMENTS/execution-status.md`:

```markdown
---
started: { datetime }
worktree: ../epic-$ARGUMENTS
branch: epic/$ARGUMENTS
---

# Execution Status

## Active Agents

- Agent-1: Issue reclux-abc123 Stream A (Database) - Started {time}
- Agent-2: Issue reclux-abc123 Stream B (API) - Started {time}
- Agent-3: Issue reclux-def456 Stream A (UI) - Started {time}

## Queued Issues

- Issue reclux-ghi789 - Waiting for reclux-abc123
- Issue reclux-jkl012 - Waiting for reclux-def456

## Completed

- {None yet}
```

### 6. Monitor and Coordinate

Set up monitoring:

```bash
echo "
Agents launched successfully!

Monitor progress:
  /pm:epic-status $ARGUMENTS

View worktree changes:
  cd ../epic-$ARGUMENTS && git status

View commits:
  cd ../epic-$ARGUMENTS && git log --oneline origin/main..HEAD

Stop all agents:
  /pm:epic-stop $ARGUMENTS

Create stacked PRs:
  /pm:epic-spr-update $ARGUMENTS

Merge stacked PRs:
  /pm:epic-spr-merge $ARGUMENTS

Traditional merge:
  /pm:epic-merge $ARGUMENTS
"
```

### 7. Handle Dependencies

As agents complete streams:

- Check if any blocked issues are now ready
- Launch new agents for newly-ready work
- Update execution-status.md

## Output Format

```
🚀 Epic Execution Started: $ARGUMENTS

Worktree: ../epic-$ARGUMENTS
Branch: epic/$ARGUMENTS

Launching {total} agents across {issue_count} issues:

Issue reclux-abc123: Database Schema
  ├─ Stream A: Schema creation (Agent-1) ✓ Started
  └─ Stream B: Migrations (Agent-2) ✓ Started

Issue reclux-def456: API Endpoints
  ├─ Stream A: User endpoints (Agent-3) ✓ Started
  ├─ Stream B: Post endpoints (Agent-4) ✓ Started
  └─ Stream C: Tests (Agent-5) ⏸ Waiting for A & B

Blocked Issues (2):
  - reclux-ghi789: UI Components (depends on reclux-abc123)
  - reclux-jkl012: Integration (depends on reclux-def456, reclux-ghi789)

Monitor with: /pm:epic-status $ARGUMENTS
```

## Error Handling

If agent launch fails:

```
❌ Failed to start Agent-{id}
  Issue: {beads_id}
  Stream: {stream}
  Error: {reason}

Continue with other agents? (yes/no)
```

If worktree creation fails:

```
❌ Cannot create worktree
  {git error message}

Try: git worktree prune
Or: Check existing worktrees with: git worktree list
```

## Important Notes

- Follow the worktree-operations rule for git operations
- Follow the agent-coordination rule for parallel work
- Agents work in the SAME worktree (not separate ones)
- Maximum parallel agents should be reasonable (e.g., 5-10)
- Monitor system resources if launching many agents
