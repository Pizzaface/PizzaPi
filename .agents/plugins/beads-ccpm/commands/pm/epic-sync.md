---
allowed-tools: Bash, Read, Write, LS, Task
---

# Epic Sync

Push epic and tasks to Beads as tracked issues with dependencies.

## Usage

```
/pm:epic-sync <feature_name>
```

## Quick Check

```bash
# Verify Beads is initialized
test -d .beads || echo "❌ Beads not initialized. Run: bd init"

# Verify epic exists
test -f .project/epics/$ARGUMENTS/epic.md || echo "❌ Epic not found. Run: /pm:prd-parse $ARGUMENTS"

# Count task files
ls .project/epics/$ARGUMENTS/*.md 2>/dev/null | grep -v epic.md | wc -l
```

If no tasks found: "❌ No tasks to sync. Run: /pm:epic-decompose $ARGUMENTS"

## Instructions

### 0. Check Beads Initialization

Follow the beads-operations rule to ensure Beads is ready:

```bash
# Check if Beads is initialized
if [ ! -d ".beads" ]; then
  echo "❌ ERROR: Beads not initialized!"
  echo ""
  echo "To fix this, run: bd init"
  exit 1
fi
```

### 1. Create Epic Issue in Beads

Strip frontmatter and prepare issue description:

```bash
# Extract content without frontmatter
sed '1,/^---$/d; 1,/^---$/d' .project/epics/$ARGUMENTS/epic.md > /tmp/epic-body-raw.md

# Remove "## Tasks Created" section and replace with Stats
awk '
  /^## Tasks Created/ {
    in_tasks=1
    next
  }
  /^## / && in_tasks {
    in_tasks=0
    # When we hit the next section after Tasks Created, add Stats
    if (total_tasks) {
      print "## Stats"
      print ""
      print "Total tasks: " total_tasks
      print "Parallel tasks: " parallel_tasks " (can be worked on simultaneously)"
      print "Sequential tasks: " sequential_tasks " (have dependencies)"
      if (total_effort) print "Estimated total effort: " total_effort " hours"
      print ""
    }
  }
  /^Total tasks:/ && in_tasks { total_tasks = $3; next }
  /^Parallel tasks:/ && in_tasks { parallel_tasks = $3; next }
  /^Sequential tasks:/ && in_tasks { sequential_tasks = $3; next }
  /^Estimated total effort:/ && in_tasks {
    gsub(/^Estimated total effort: /, "")
    total_effort = $0
    next
  }
  !in_tasks { print }
  END {
    # If we were still in tasks section at EOF, add stats
    if (in_tasks && total_tasks) {
      print "## Stats"
      print ""
      print "Total tasks: " total_tasks
      print "Parallel tasks: " parallel_tasks " (can be worked on simultaneously)"
      print "Sequential tasks: " sequential_tasks " (have dependencies)"
      if (total_effort) print "Estimated total effort: " total_effort
    }
  }
' /tmp/epic-body-raw.md > /tmp/epic-body.md

# Determine epic type (feature vs bug) from content
if grep -qi "bug\|fix\|issue\|problem\|error" /tmp/epic-body.md; then
  epic_type="bug"
else
  epic_type="feature"
fi

# Create epic issue in Beads
epic_id=$(bd create \
  --title "Epic: $ARGUMENTS" \
  --type=epic \
  --priority=1 \
  --labels "epic,epic:$ARGUMENTS,$epic_type" \
  --body-file /tmp/epic-body.md \
  --silent)

echo "Created epic: $epic_id"
```

Store the returned issue ID for epic frontmatter update.

### 2. Create Task Issues as Epic Children

Count task files to determine strategy:

```bash
task_count=$(ls .project/epics/$ARGUMENTS/[0-9][0-9][0-9].md 2>/dev/null | wc -l)
```

### For Small Batches (< 5 tasks): Sequential Creation

```bash
if [ "$task_count" -lt 5 ]; then
  # Create sequentially for small batches
  echo -n "" > /tmp/task-mapping.txt  # Initialize empty mapping file

  for task_file in .project/epics/$ARGUMENTS/[0-9][0-9][0-9].md; do
    [ -f "$task_file" ] || continue

    # Extract task name from frontmatter
    task_name=$(grep '^name:' "$task_file" | sed 's/^name: *//')

    # Strip frontmatter from task content
    sed '1,/^---$/d; 1,/^---$/d' "$task_file" > /tmp/task-body.md

    # Create child task under epic with timeout
    task_id=$(timeout 10s bd create \
      --title "$task_name" \
      --type=task \
      --parent="$epic_id" \
      --labels "task,epic:$ARGUMENTS" \
      --body-file /tmp/task-body.md \
      --silent)

    # Record mapping for renaming
    echo "$task_file:$task_id" >> /tmp/task-mapping.txt
    echo "Created: $task_id - $task_name"
  done

  # After creating all issues, update references and rename files
  # This follows the same process as step 3 below
fi
```

### For Larger Batches: Parallel Creation

```bash
if [ "$task_count" -ge 5 ]; then
  echo "Creating $task_count tasks in parallel..."

  # Batch tasks for parallel processing
  # Spawn agents to create tasks in parallel
fi
```

Use Task tool for parallel creation:

```yaml
Task:
  description: 'Create Beads tasks batch {X}'
  subagent_type: 'general-purpose'
  prompt: |
    Create Beads tasks for epic $ARGUMENTS
    Parent epic: $epic_id

    Tasks to process:
    - {list of 3-4 task files}

    For each task file:
    1. Extract task name from frontmatter
    2. Strip frontmatter using: sed '1,/^---$/d; 1,/^---$/d'
    3. Create child task using:
       bd create --title "$task_name" --type=task --parent="$epic_id" \
         --labels "task,epic:$ARGUMENTS" --body-file /tmp/task-body.md --silent
    4. Record: task_file:task_id

    Return mapping of files to issue IDs.
```

Consolidate results from parallel agents:

```bash
# Collect all mappings from agents
cat /tmp/batch-*/mapping.txt >> /tmp/task-mapping.txt

# IMPORTANT: After consolidation, follow step 3 to:
# 1. Build old->new ID mapping
# 2. Update all task references (depends_on, conflicts_with)
# 3. Rename files with proper frontmatter updates
```

### 3. Rename Task Files and Update References

First, build a mapping of old numbers to new Beads IDs:

```bash
# Create mapping from old task numbers (001, 002, etc.) to new Beads IDs
echo -n "" > /tmp/id-mapping.txt  # Initialize empty ID mapping file
while IFS=: read -r task_file task_id; do
  # Extract old number from filename (e.g., 001 from 001.md)
  old_num=$(basename "$task_file" .md)
  echo "$old_num:$task_id" >> /tmp/id-mapping.txt
done < /tmp/task-mapping.txt
```

Then rename files and update all references:

```bash
current_date=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Process each task file
while IFS=: read -r task_file task_id; do
  new_name="$(dirname "$task_file")/${task_id}.md"

  # Read the file content
  content=$(cat "$task_file")

  # Update depends_on and conflicts_with references within brackets
  while IFS=: read -r old_num new_id; do
    # Replace within brackets, handling various formats
    content=$(echo "$content" | sed "s/\[${old_num}\]/\[${new_id}\]/g")
    content=$(echo "$content" | sed "s/\[${old_num},/\[${new_id},/g")
    content=$(echo "$content" | sed "s/, ${old_num}\]/, ${new_id}\]/g")
    content=$(echo "$content" | sed "s/, ${old_num},/, ${new_id},/g")
  done < /tmp/id-mapping.txt

  # Write updated content to new file
  echo "$content" > "$new_name"

  # Remove old file if different from new
  [ "$task_file" != "$new_name" ] && rm "$task_file"

  # Update beads_id and updated fields in frontmatter
  sed -i.bak "s/^beads_id:.*/beads_id: $task_id/" "$new_name"
  sed -i.bak "s/^updated:.*/updated: $current_date/" "$new_name"
  rm -f "${new_name}.bak"
done < /tmp/task-mapping.txt
```

### 4. Add Dependencies Between Tasks

After all tasks are created, add dependencies based on `depends_on` fields:

```bash
# Add dependencies based on depends_on fields
echo "Adding dependencies..."

for task_file in .project/epics/$ARGUMENTS/*.md; do
  [ -f "$task_file" ] || continue
  [ "$(basename $task_file)" = "epic.md" ] && continue
  [ "$(basename $task_file)" = "beads-mapping.md" ] && continue

  # Get this task's Beads ID
  task_id=$(grep '^beads_id:' "$task_file" | sed 's/^beads_id: *//')
  [ -z "$task_id" ] && continue

  # Get depends_on IDs (handle both array and single value formats)
  depends_on=$(grep '^depends_on:' "$task_file" | sed 's/^depends_on: *//' | tr -d '[]' | sed 's/,/\n/g')

  if [ -n "$depends_on" ]; then
    for dep_id in $depends_on; do
      dep_id=$(echo "$dep_id" | xargs)  # trim whitespace
      [ -z "$dep_id" ] && continue

      # Add dependency: this task depends on dep_id
      bd dep add "$task_id" "$dep_id" 2>&1 | grep -E "(✓|Error)" || true
    done
  fi
done

echo ""
echo "✅ Dependencies configured"
```

### 5. Update Epic File

Update the epic file with Beads ID, timestamp, and real task IDs:

#### 5a. Update Frontmatter

```bash
current_date=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Update epic frontmatter
sed -i.bak "/^beads_id:/c\beads_id: $epic_id" .project/epics/$ARGUMENTS/epic.md
sed -i.bak "/^updated:/c\updated: $current_date" .project/epics/$ARGUMENTS/epic.md
rm .project/epics/$ARGUMENTS/epic.md.bak
```

#### 5b. Update Tasks Created Section

```bash
# Create a temporary file with the updated Tasks Created section
cat > /tmp/tasks-section.md << 'EOF'
## Tasks Created
EOF

# Add each task with its real Beads ID
for task_file in .project/epics/$ARGUMENTS/*.md; do
  [ -f "$task_file" ] || continue
  [ "$(basename $task_file)" = "epic.md" ] && continue
  [ "$(basename $task_file)" = "beads-mapping.md" ] && continue

  # Get Beads ID from frontmatter
  beads_id=$(grep '^beads_id:' "$task_file" | sed 's/^beads_id: *//')
  [ -z "$beads_id" ] && beads_id=$(basename "$task_file" .md)

  # Get task name from frontmatter
  task_name=$(grep '^name:' "$task_file" | sed 's/^name: *//')

  # Get parallel status
  parallel=$(grep '^parallel:' "$task_file" | sed 's/^parallel: *//')

  # Add to tasks section
  echo "- [ ] ${beads_id} - ${task_name} (parallel: ${parallel})" >> /tmp/tasks-section.md
done

# Add summary statistics
total_count=$(ls .project/epics/$ARGUMENTS/*.md 2>/dev/null | grep -v epic.md | grep -v beads-mapping.md | wc -l)
parallel_count=$(grep -l '^parallel: true' .project/epics/$ARGUMENTS/*.md 2>/dev/null | wc -l)
sequential_count=$((total_count - parallel_count))

cat >> /tmp/tasks-section.md << EOF

Total tasks: ${total_count}
Parallel tasks: ${parallel_count}
Sequential tasks: ${sequential_count}
EOF

# Replace the Tasks Created section in epic.md
# First, create a backup
cp .project/epics/$ARGUMENTS/epic.md .project/epics/$ARGUMENTS/epic.md.backup

# Use awk to replace the section
awk '
  /^## Tasks Created/ {
    skip=1
    while ((getline line < "/tmp/tasks-section.md") > 0) print line
    close("/tmp/tasks-section.md")
  }
  /^## / && !/^## Tasks Created/ { skip=0 }
  !skip && !/^## Tasks Created/ { print }
' .project/epics/$ARGUMENTS/epic.md.backup > .project/epics/$ARGUMENTS/epic.md

# Clean up
rm .project/epics/$ARGUMENTS/epic.md.backup
rm /tmp/tasks-section.md
```

### 6. Create Mapping File

Create `.project/epics/$ARGUMENTS/beads-mapping.md`:

```bash
# Create mapping file
cat > .project/epics/$ARGUMENTS/beads-mapping.md << EOF
# Beads Issue Mapping

Epic: ${epic_id}

Tasks:
EOF

# Add each task mapping
for task_file in .project/epics/$ARGUMENTS/*.md; do
  [ -f "$task_file" ] || continue
  [ "$(basename $task_file)" = "epic.md" ] && continue
  [ "$(basename $task_file)" = "beads-mapping.md" ] && continue

  beads_id=$(grep '^beads_id:' "$task_file" | sed 's/^beads_id: *//')
  [ -z "$beads_id" ] && beads_id=$(basename "$task_file" .md)
  task_name=$(grep '^name:' "$task_file" | sed 's/^name: *//')

  echo "- ${beads_id}: ${task_name}" >> .project/epics/$ARGUMENTS/beads-mapping.md
done

# Add sync timestamp
echo "" >> .project/epics/$ARGUMENTS/beads-mapping.md
echo "Synced: $(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> .project/epics/$ARGUMENTS/beads-mapping.md
```

### 7. Create Worktree (Optional)

Follow the worktree-operations rule to create development worktree:

```bash
# Ensure main is current
git checkout main
git pull origin main

# Create worktree for epic
git worktree add ../epic-$ARGUMENTS -b epic/$ARGUMENTS

echo "Created worktree: ../epic-$ARGUMENTS"
```

### 8. Sync Beads

```bash
bd sync
```

### 9. Output

```
Synced to Beads
  - Epic: {epic_id}
  - Tasks: {count} child issues created
  - Labels applied: epic, task, epic:{name}
  - Files renamed: 001.md → {beads_id}.md
  - References updated: depends_on/conflicts_with now use Beads IDs
  - Dependencies: Added to Beads dependency graph
  - Worktree: ../epic-$ARGUMENTS (if created)

Next steps:
  - Start parallel execution: /pm:epic-start $ARGUMENTS
  - Or work on single issue: /pm:issue-start {beads_id}
  - View epic: bd show {epic_id}
  - View ready tasks: bd ready
```

## Error Handling

Follow the beads-operations rule for Beads CLI errors.

If any issue creation fails:

- Report what succeeded
- Note what failed
- Don't attempt rollback (partial sync is fine)

## Important Notes

- Trust Beads CLI is installed
- Don't pre-check for duplicates
- Update frontmatter only after successful creation
- Keep operations simple and atomic
- Run `bd sync` at the end to persist changes
