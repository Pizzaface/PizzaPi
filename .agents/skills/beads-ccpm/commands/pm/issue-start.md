---
allowed-tools: Bash, Read, Write, LS, Task
---

# Issue Start

Begin work on a Beads issue with parallel agents based on work stream analysis.

## Usage

```
/pm:issue-start <beads_id>
```

## Quick Check

1. **Get issue details:**

   ```bash
   bd show $ARGUMENTS --json
   ```

   If it fails: "❌ Cannot access issue $ARGUMENTS. Check ID or run: bd list"

2. **Find local task file:**
   - First check if `.project/epics/*/$ARGUMENTS.md` exists (new naming)
   - If not found, search for file containing `beads_id: $ARGUMENTS` in frontmatter
   - If not found: "❌ No local task for issue $ARGUMENTS. This issue may have been created outside the PM system."

3. **Check for analysis:**

   ```bash
   test -f .project/epics/*/$ARGUMENTS-analysis.md || echo "❌ No analysis found for issue $ARGUMENTS

   Run: /pm:issue-analyze $ARGUMENTS first
   Or: /pm:issue-start $ARGUMENTS --analyze to do both"
   ```

   If no analysis exists and no --analyze flag, stop execution.

## Instructions

### 1. Ensure Worktree Exists

Check if epic worktree exists:

```bash
# Find epic name from task file
epic_name={extracted_from_path}

# Check worktree
if ! git worktree list | grep -q "epic-$epic_name"; then
  echo "❌ No worktree for epic. Run: /pm:epic-start $epic_name"
  exit 1
fi
```

### 2. Read Analysis

Read `.project/epics/{epic_name}/$ARGUMENTS-analysis.md`:

- Parse parallel streams
- Identify which can start immediately
- Note dependencies between streams

### 3. Setup Progress Tracking

Get current datetime: `date -u +"%Y-%m-%dT%H:%M:%SZ"`

Create workspace structure:

```bash
mkdir -p .project/epics/{epic_name}/updates/$ARGUMENTS
```

Update task file frontmatter `updated` field with current datetime.

### 4. Launch Parallel Agents

For each stream that can start immediately:

Create `.project/epics/{epic_name}/updates/$ARGUMENTS/stream-{X}.md`:

```markdown
---
issue: $ARGUMENTS
stream: { stream_name }
agent: { agent_type }
started: { current_datetime }
status: in_progress
---

# Stream {X}: {stream_name}

## Scope

{stream_description}

## Files

{file_patterns}

## Progress

- Starting implementation
```

Launch agent using Task tool:

```yaml
Task:
  description: 'Issue $ARGUMENTS Stream {X}'
  subagent_type: '{agent_type}'
  prompt: |
    You are working on Issue $ARGUMENTS in the epic worktree.

    Worktree location: ../epic-{epic_name}/
    Your stream: {stream_name}

    Your scope:
    - Files to modify: {file_patterns}
    - Work to complete: {stream_description}

    Requirements:
    1. Read full task from: .project/epics/{epic_name}/{task_file}
    2. Work ONLY in your assigned files
    3. Commit frequently with format: "Issue $ARGUMENTS: {specific change}"
    4. Update progress in: .project/epics/{epic_name}/updates/$ARGUMENTS/stream-{X}.md
    5. Follow coordination rules in /rules/agent-coordination.md

    If you need to modify files outside your scope:
    - Check if another stream owns them
    - Wait if necessary
    - Update your progress file with coordination notes

    Complete your stream's work and mark as completed when done.
```

### 5. Beads Assignment

```bash
# Claim work in Beads
bd update $ARGUMENTS --status=in_progress
bd update $ARGUMENTS --assignee=$(git config user.name || echo "@me")

# Add label if supported
bd label add $ARGUMENTS in-progress 2>/dev/null || true
```

### 6. Sync Beads

```bash
bd sync
```

### 7. Output

```
Started parallel work on issue $ARGUMENTS

Epic: {epic_name}
Worktree: ../epic-{epic_name}/

Launching {count} parallel agents:
  Stream A: {name} (Agent-1) Started
  Stream B: {name} (Agent-2) Started
  Stream C: {name} - Waiting (depends on A)

Progress tracking:
  .project/epics/{epic_name}/updates/$ARGUMENTS/

Monitor with: /pm:epic-status {epic_name}
Sync updates: /pm:issue-sync $ARGUMENTS
View in Beads: bd show $ARGUMENTS
```

## Error Handling

If any step fails, report clearly:

- "❌ {What failed}: {How to fix}"
- Continue with what's possible
- Never leave partial state

## Important Notes

Follow the datetime rule for timestamps.
Follow the beads-operations rule for Beads commands.
Keep it simple - trust that Beads and file system work.
