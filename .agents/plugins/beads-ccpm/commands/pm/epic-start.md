---
allowed-tools: Bash, Read, Write, LS, Task
---

# Epic Start

Launch parallel agents to work on epic tasks in a shared branch.

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

3. **Check for branch:**

   ```bash
   git branch -a | grep "epic/$ARGUMENTS"
   ```

4. **Check for uncommitted changes:**
   ```bash
   git status --porcelain
   ```
   If output is not empty: "❌ You have uncommitted changes. Please commit or stash them before starting an epic"

## Instructions

### 1. Create or Enter Branch

Follow the branch-operations rule:

```bash
# Check for uncommitted changes
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ You have uncommitted changes. Please commit or stash them before starting an epic."
  exit 1
fi

# If branch doesn't exist, create it
if ! git branch -a | grep -q "epic/$ARGUMENTS"; then
  git checkout main
  git pull origin main
  git checkout -b epic/$ARGUMENTS
  git push -u origin epic/$ARGUMENTS
  echo "Created branch: epic/$ARGUMENTS"
else
  git checkout epic/$ARGUMENTS
  git pull origin epic/$ARGUMENTS
  echo "Using existing branch: epic/$ARGUMENTS"
fi
```

### 2. Identify Ready Issues

Read all task files in `.project/epics/$ARGUMENTS/`:

- Parse frontmatter for `status`, `depends_on`, `parallel` fields
- Check Beads issue status if needed
- Build dependency graph

Categorize issues:

- **Ready**: No unmet dependencies, not started
- **Blocked**: Has unmet dependencies
- **In Progress**: Already being worked on
- **Complete**: Finished

Use Beads to check ready work:

```bash
bd ready
```

### 3. Analyze Ready Issues

For each ready issue without analysis:

```bash
# Check for analysis
if ! test -f .project/epics/$ARGUMENTS/{issue}-analysis.md; then
  echo "Analyzing issue {issue}..."
  # Run analysis (inline or via Task tool)
fi
```

### 4. Launch Parallel Agents

For each ready issue with analysis:

```markdown
## Starting Issue {issue}: {title}

Reading analysis...
Found {count} parallel streams:

- Stream A: {description} (Agent-{id})
- Stream B: {description} (Agent-{id})

Launching agents in branch: epic/$ARGUMENTS
```

Use Task tool to launch each stream:

```yaml
Task:
  description: 'Issue {issue} Stream {X}'
  subagent_type: '{agent_type}'
  prompt: |
    Working in branch: epic/$ARGUMENTS
    Issue: {issue} - {title}
    Stream: {stream_name}

    Your scope:
    - Files: {file_patterns}
    - Work: {stream_description}

    Read full requirements from:
    - .project/epics/$ARGUMENTS/{task_file}
    - .project/epics/$ARGUMENTS/{issue}-analysis.md

    Follow coordination rules in /rules/agent-coordination.md

    Commit frequently with message format:
    "Issue {issue}: {specific change}"

    Update progress in:
    .project/epics/$ARGUMENTS/updates/{issue}/stream-{X}.md
```

### 5. Update Beads Status

```bash
# Mark issues as in_progress in Beads
for issue_id in {ready_issue_ids}; do
  bd update "$issue_id" --status=in_progress
done

# Sync changes
bd sync
```

### 6. Track Active Agents

Create/update `.project/epics/$ARGUMENTS/execution-status.md`:

```markdown
---
started: { datetime }
branch: epic/$ARGUMENTS
---

# Execution Status

## Active Agents

- Agent-1: Issue {id1} Stream A (Database) - Started {time}
- Agent-2: Issue {id1} Stream B (API) - Started {time}
- Agent-3: Issue {id2} Stream A (UI) - Started {time}

## Queued Issues

- Issue {id3} - Waiting for {id1}
- Issue {id4} - Waiting for {id2}

## Completed

- {None yet}
```

### 7. Monitor and Coordinate

Set up monitoring:

```bash
echo "
Agents launched successfully!

Monitor progress:
  /pm:epic-status $ARGUMENTS

View branch changes:
  git status

View commits:
  git log --oneline origin/main..HEAD

View ready work:
  bd ready

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

### 8. Handle Dependencies

As agents complete streams:

- Check if any blocked issues are now ready
- Launch new agents for newly-ready work
- Update execution-status.md

## Output Format

```
Epic Execution Started: $ARGUMENTS

Branch: epic/$ARGUMENTS

Launching {total} agents across {issue_count} issues:

Issue {id1}: Database Schema
  - Stream A: Schema creation (Agent-1) Started
  - Stream B: Migrations (Agent-2) Started

Issue {id2}: API Endpoints
  - Stream A: User endpoints (Agent-3) Started
  - Stream B: Post endpoints (Agent-4) Started
  - Stream C: Tests (Agent-5) Waiting for A & B

Blocked Issues (2):
  - {id3}: UI Components (depends on {id1})
  - {id4}: Integration (depends on {id2}, {id3})

Monitor with: /pm:epic-status $ARGUMENTS
View ready: bd ready
```

## Error Handling

If agent launch fails:

```
❌ Failed to start Agent-{id}
  Issue: {issue}
  Stream: {stream}
  Error: {reason}

Continue with other agents? (yes/no)
```

If uncommitted changes are found:

```
❌ You have uncommitted changes. Please commit or stash them before starting an epic.

To commit changes:
  git add .
  git commit -m "Your commit message"

To stash changes:
  git stash push -m "Work in progress"
  # (Later restore with: git stash pop)
```

If branch creation fails:

```
❌ Cannot create branch
  {git error message}

Try: git branch -d epic/$ARGUMENTS
Or: Check existing branches with: git branch -a
```

## Important Notes

- Follow the branch-operations rule for git operations
- Follow `/rules/agent-coordination.md` for parallel work
- Follow the beads-operations rule for Beads commands
- Agents work in the SAME branch (not separate branches)
- Maximum parallel agents should be reasonable (e.g., 5-10)
- Monitor system resources if launching many agents
