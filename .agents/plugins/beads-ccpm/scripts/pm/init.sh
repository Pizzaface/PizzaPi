#!/bin/bash

echo "Initializing..."
echo ""
echo ""

echo "██████╗ ███████╗ █████╗ ██████╗ ███████╗"
echo "██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔════╝"
echo "██████╔╝█████╗  ███████║██║  ██║███████╗"
echo "██╔══██╗██╔══╝  ██╔══██║██║  ██║╚════██║"
echo "██████╔╝███████╗██║  ██║██████╔╝███████║"
echo "╚═════╝ ╚══════╝╚═╝  ╚═╝╚═════╝ ╚══════╝"

echo "┌──────────────────────────────────┐"
echo "│     Beads Project Management      │"
echo "│  Powered by Beads Task Tracker   │"
echo "│       and CCPM (original)        │"
echo "└──────────────────────────────────┘"
echo "https://github.com/steveyegge/beads"
echo "and"
echo "https://github.com/automazeio/ccpm"
echo ""
echo ""
echo "Initializing Beads PM System"
echo "============================"
echo ""

# Check for required tools
echo "Checking dependencies..."

# Check Beads CLI
if command -v bd &> /dev/null; then
  echo "  Beads CLI (bd) installed"
else
  echo "  Beads CLI (bd) not found"
  echo ""
  echo "  Installing Beads..."
  curl -fsSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash

  # Verify installation
  if ! command -v bd &> /dev/null; then
    echo "  Please install Beads manually: https://github.com/steveyegge/beads"
    exit 1
  fi
  echo "  Beads installed successfully"
fi

# Check for git
echo ""
echo "Checking Git configuration..."
if git rev-parse --git-dir > /dev/null 2>&1; then
  echo "  Git repository detected"

  # Check remote
  if git remote -v | grep -q origin; then
    remote_url=$(git remote get-url origin)
    echo "  Remote configured: $remote_url"
  else
    echo "  Warning: No remote configured"
    echo "  Add with: git remote add origin <url>"
  fi
else
  echo "  Warning: Not a git repository"
  echo "  Initialize with: git init"
fi

# Initialize Beads if not already
echo ""
echo "Initializing Beads..."
if [ -d ".beads" ]; then
  echo "  Beads already initialized"
  echo "  Database: .beads/beads.db"
else
  # Initialize Beads (chain with existing hooks)
  echo "1" | bd init

  if [ -d ".beads" ]; then
    echo "  Beads initialized successfully"
  else
    echo "  Failed to initialize Beads"
    exit 1
  fi
fi

# Create project data directory structure
echo ""
echo "Creating project data directories..."
mkdir -p .project/prds
mkdir -p .project/epics
mkdir -p .project/context
mkdir -p .project/adrs
echo "  Directories created"

# Create CLAUDE.md if it doesn't exist
if [ ! -f "CLAUDE.md" ]; then
  echo ""
  echo "Creating CLAUDE.md..."
  cat > CLAUDE.md << 'EOF'
# CLAUDE.md

> Think carefully and implement the most concise solution that changes as little code as possible.

## Project-Specific Instructions

Add your project-specific instructions here.

## Task Management

This project uses Beads for task management. Key commands:
- `bd ready` - Show available work
- `bd create --title="..." --type=task` - Create a task
- `bd show <id>` - View task details
- `bd close <id>` - Complete a task
- `bd sync` - Sync with git

## Testing

Always run tests before committing:
- `npm test` or equivalent for your stack

## Code Style

Follow existing patterns in the codebase.
EOF
  echo "  CLAUDE.md created"
fi

# Run Beads doctor to check health
echo ""
echo "Checking Beads health..."
bd doctor 2>&1 | head -20

# Summary
echo ""
echo "Initialization Complete!"
echo "========================"
echo ""
echo "System Status:"
bd --version 2>/dev/null || echo "  Beads: installed"
echo "  Database: .beads/beads.db"
bd info 2>&1 | grep -E "Issues|Open|Closed" | head -3 || true
echo ""
echo "Next Steps:"
echo "  1. Create your first PRD: /pm:prd-new <feature-name>"
echo "  2. View help: /pm:help"
echo "  3. Check status: /pm:status"
echo "  4. View available work: bd ready"
echo ""
echo "Beads Documentation: https://github.com/steveyegge/beads"

exit 0
