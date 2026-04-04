package compat

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	mustMkdirAll(t, filepath.Dir(path))
	mustWriteFile(t, path, []byte(content))
}

func mustMkdirAll(t *testing.T, path string) {
	t.Helper()
	if err := mkdirAll(path); err != nil {
		t.Fatalf("mkdirAll(%q): %v", path, err)
	}
}

func mustWriteFile(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := writeTextFile(path, content); err != nil {
		t.Fatalf("writeTextFile(%q): %v", path, err)
	}
}

// makeGitRepo creates a bare .git directory marker so GitRoot detection works.
func makeGitRepo(t *testing.T, dir string) {
	t.Helper()
	mustMkdirAll(t, filepath.Join(dir, ".git"))
}

func TestAgentRootsOrder(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	cwd := filepath.Join(t.TempDir(), "repo", "app")
	locator := NewLocator(home, cwd)

	got := locator.AgentRoots()
	want := []PathCandidate{
		{Path: filepath.Join(cwd, ".pizzapi", "agents"), Family: FamilyPizzaPi, Scope: ScopeProject, Priority: 1},
		{Path: filepath.Join(cwd, ".claude", "agents"), Family: FamilyClaude, Scope: ScopeProject, Priority: 2},
		{Path: filepath.Join(home, ".pizzapi", "agents"), Family: FamilyPizzaPi, Scope: ScopeGlobal, Priority: 3},
		{Path: filepath.Join(home, ".claude", "agents"), Family: FamilyClaude, Scope: ScopeGlobal, Priority: 4},
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("AgentRoots() mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestDiscoverAgentsPrecedence(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	cwd := filepath.Join(t.TempDir(), "repo")
	locator := NewLocator(home, cwd)

	writeFile(t, filepath.Join(home, ".claude", "agents", "shared.md"), "# global claude")
	writeFile(t, filepath.Join(home, ".pizzapi", "agents", "shared.md"), "# global pizzapi")
	writeFile(t, filepath.Join(cwd, ".claude", "agents", "shared.md"), "# project claude")
	writeFile(t, filepath.Join(cwd, ".pizzapi", "agents", "shared.md"), "# project pizzapi")
	writeFile(t, filepath.Join(home, ".claude", "agents", "global-only.md"), "# global only")
	writeFile(t, filepath.Join(cwd, ".claude", "agents", "project-only.md"), "# project only")

	got, err := locator.DiscoverAgents()
	if err != nil {
		t.Fatalf("DiscoverAgents(): %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("expected 3 agents, got %d: %#v", len(got), got)
	}

	if got[0].Name != "shared" || got[0].Path != filepath.Join(cwd, ".pizzapi", "agents", "shared.md") {
		t.Fatalf("shared agent precedence mismatch: %#v", got[0])
	}
	if got[1].Name != "project-only" || got[1].Scope != ScopeProject || got[1].Family != FamilyClaude {
		t.Fatalf("project-only agent mismatch: %#v", got[1])
	}
	if got[2].Name != "global-only" || got[2].Scope != ScopeGlobal || got[2].Family != FamilyClaude {
		t.Fatalf("global-only agent mismatch: %#v", got[2])
	}
}

func TestDiscoverSkillsSupportsRootAndSubdirLayouts(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	cwd := filepath.Join(t.TempDir(), "repo")
	locator := NewLocator(home, cwd)

	sharedFM := "---\ndescription: global claude skill\n---\n# content"
	writeFile(t, filepath.Join(home, ".claude", "skills", "shared", "SKILL.md"), sharedFM)
	writeFile(t, filepath.Join(cwd, ".claude", "skills", "shared.md"), "---\ndescription: project claude skill\n---\n")
	writeFile(t, filepath.Join(cwd, ".pizzapi", "skills", "shared", "SKILL.md"), "---\ndescription: project pizzapi skill\n---\n")
	writeFile(t, filepath.Join(cwd, ".claude", "skills", "solo.md"), "---\ndescription: solo skill\n---\n")

	got, err := locator.DiscoverSkills()
	if err != nil {
		t.Fatalf("DiscoverSkills(): %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 skills, got %d: %#v", len(got), got)
	}

	if got[0].Name != "shared" || got[0].Path != filepath.Join(cwd, ".pizzapi", "skills", "shared", "SKILL.md") {
		t.Fatalf("shared skill precedence mismatch: %#v", got[0])
	}
	if got[0].Description != "project pizzapi skill" {
		t.Fatalf("shared skill description mismatch: %q", got[0].Description)
	}
	if got[1].Name != "solo" || got[1].Path != filepath.Join(cwd, ".claude", "skills", "solo.md") {
		t.Fatalf("solo skill mismatch: %#v", got[1])
	}
}

// --- New tests for Dish 005 ---

// TestDiscoverSkillsSkipsWithoutDescription verifies that skills missing a
// description field in their frontmatter are not returned.
func TestDiscoverSkillsSkipsWithoutDescription(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	cwd := filepath.Join(t.TempDir(), "repo")
	locator := NewLocator(home, cwd)

	// No frontmatter at all — must be skipped.
	writeFile(t, filepath.Join(cwd, ".pizzapi", "skills", "nodesc.md"), "# just a heading")
	// Frontmatter without description — must be skipped.
	writeFile(t, filepath.Join(cwd, ".pizzapi", "skills", "partial", "SKILL.md"), "---\nname: partial\n---\n# content")
	// Frontmatter with description — must be returned.
	writeFile(t, filepath.Join(cwd, ".pizzapi", "skills", "full.md"), "---\ndescription: A real skill\n---\n# content")

	got, err := locator.DiscoverSkills()
	if err != nil {
		t.Fatalf("DiscoverSkills(): %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 skill (only full.md), got %d: %#v", len(got), got)
	}
	if got[0].Name != "full" {
		t.Fatalf("expected skill name 'full', got %q", got[0].Name)
	}
	if got[0].Description != "A real skill" {
		t.Fatalf("expected description 'A real skill', got %q", got[0].Description)
	}
}

// TestDiscoverSkillsCollisionKeepsFirstFound verifies that when two roots
// provide a skill with the same name, the higher-precedence one wins.
func TestDiscoverSkillsCollisionKeepsFirstFound(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	cwd := filepath.Join(t.TempDir(), "repo")
	locator := NewLocator(home, cwd)

	// Higher precedence: project .pizzapi
	writeFile(t, filepath.Join(cwd, ".pizzapi", "skills", "tool.md"), "---\ndescription: project version\n---\n")
	// Lower precedence: project .claude — same name "tool"
	writeFile(t, filepath.Join(cwd, ".claude", "skills", "tool.md"), "---\ndescription: claude version\n---\n")
	// Global — same name again
	writeFile(t, filepath.Join(home, ".pizzapi", "skills", "tool.md"), "---\ndescription: global version\n---\n")

	got, err := locator.DiscoverSkills()
	if err != nil {
		t.Fatalf("DiscoverSkills(): %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 skill after collision dedup, got %d: %#v", len(got), got)
	}
	if got[0].Description != "project version" {
		t.Fatalf("expected highest-precedence description 'project version', got %q", got[0].Description)
	}
	if got[0].Scope != ScopeProject || got[0].Family != FamilyPizzaPi {
		t.Fatalf("expected project pizzapi scope/family, got scope=%q family=%q", got[0].Scope, got[0].Family)
	}
}

// TestDiscoverSkillsCodexPathsIncluded verifies that .codex/skills/ directories
// are scanned as part of skill discovery.
func TestDiscoverSkillsCodexPathsIncluded(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	cwd := filepath.Join(t.TempDir(), "repo")
	locator := NewLocator(home, cwd)

	writeFile(t, filepath.Join(cwd, ".codex", "skills", "codex-skill.md"),
		"---\ndescription: A codex skill\n---\n")
	writeFile(t, filepath.Join(home, ".codex", "skills", "global-codex", "SKILL.md"),
		"---\ndescription: Global codex skill\n---\n")

	got, err := locator.DiscoverSkills()
	if err != nil {
		t.Fatalf("DiscoverSkills(): %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 skills from codex paths, got %d: %#v", len(got), got)
	}

	nameSet := map[string]bool{}
	for _, r := range got {
		nameSet[r.Name] = true
	}
	if !nameSet["codex-skill"] {
		t.Fatalf("codex-skill not found; got: %#v", got)
	}
	if !nameSet["global-codex"] {
		t.Fatalf("global-codex not found; got: %#v", got)
	}
}

// TestSkillRootsIncludesCodexPaths verifies that SkillRoots returns codex paths.
func TestSkillRootsIncludesCodexPaths(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	cwd := filepath.Join(t.TempDir(), "repo")
	locator := NewLocator(home, cwd)

	roots := locator.SkillRoots()
	var hasProjectCodex, hasGlobalCodex bool
	for _, r := range roots {
		if r.Path == filepath.Join(cwd, ".codex", "skills") {
			hasProjectCodex = true
			if r.Family != FamilyCodex {
				t.Errorf("project codex root has wrong family: %q", r.Family)
			}
			if r.Scope != ScopeProject {
				t.Errorf("project codex root has wrong scope: %q", r.Scope)
			}
		}
		if r.Path == filepath.Join(home, ".codex", "skills") {
			hasGlobalCodex = true
			if r.Family != FamilyCodex {
				t.Errorf("global codex root has wrong family: %q", r.Family)
			}
			if r.Scope != ScopeGlobal {
				t.Errorf("global codex root has wrong scope: %q", r.Scope)
			}
		}
	}
	if !hasProjectCodex {
		t.Fatalf("project .codex/skills not in SkillRoots(); got: %#v", roots)
	}
	if !hasGlobalCodex {
		t.Fatalf("global .codex/skills not in SkillRoots(); got: %#v", roots)
	}
}

// TestDiscoverSkillsDisabled verifies that SkillsDisabled causes DiscoverSkills
// to return an empty slice without scanning disk.
func TestDiscoverSkillsDisabled(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	cwd := filepath.Join(t.TempDir(), "repo")
	locator := NewLocator(home, cwd, LocatorConfig{SkillsDisabled: true})

	// Plant a valid skill — should not be returned when disabled.
	writeFile(t, filepath.Join(cwd, ".pizzapi", "skills", "alpha.md"),
		"---\ndescription: Should not appear\n---\n")

	got, err := locator.DiscoverSkills()
	if err != nil {
		t.Fatalf("DiscoverSkills() with disabled: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected 0 skills when disabled, got %d: %#v", len(got), got)
	}
}

// TestParseSkillFrontmatter covers the frontmatter extraction helper directly.
func TestParseSkillFrontmatter(t *testing.T) {
	cases := []struct {
		name     string
		content  string
		wantName string
		wantDesc string
	}{
		{
			name:     "full frontmatter",
			content:  "---\nname: my-skill\ndescription: Does something useful\n---\n# body",
			wantName: "my-skill",
			wantDesc: "Does something useful",
		},
		{
			name:     "description only",
			content:  "---\ndescription: Just a description\n---\n",
			wantName: "",
			wantDesc: "Just a description",
		},
		{
			name:     "no frontmatter",
			content:  "# plain heading\nsome text",
			wantName: "",
			wantDesc: "",
		},
		{
			name:     "empty frontmatter block",
			content:  "---\n---\n# body",
			wantName: "",
			wantDesc: "",
		},
		{
			name:     "frontmatter missing description key",
			content:  "---\nname: only-name\nauthor: someone\n---\n",
			wantName: "only-name",
			wantDesc: "",
		},
		{
			name:     "description with leading spaces in value",
			content:  "---\ndescription:   Trimmed description   \n---\n",
			wantName: "",
			wantDesc: "Trimmed description",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotName, gotDesc := parseSkillFrontmatter(tc.content)
			if gotName != tc.wantName {
				t.Errorf("name: got %q, want %q", gotName, tc.wantName)
			}
			if gotDesc != tc.wantDesc {
				t.Errorf("description: got %q, want %q", gotDesc, tc.wantDesc)
			}
		})
	}
}

// TestLocatorConfigDefaultIsZeroValue verifies that NewLocator without a config
// argument produces an unlocked (not disabled) locator.
func TestLocatorConfigDefaultIsZeroValue(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	cwd := filepath.Join(t.TempDir(), "repo")
	l := NewLocator(home, cwd)

	if l.Config.SkillsDisabled {
		t.Fatal("expected SkillsDisabled=false by default")
	}
}

// TestDiscoverInstructionDocsPrecedence verifies ancestor walk order and global candidates.
// No .git is placed here so walk is unbounded (backward compatible).
func TestDiscoverInstructionDocsPrecedence(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	repo := filepath.Join(t.TempDir(), "repo")
	cwd := filepath.Join(repo, "apps", "api")
	locator := NewLocator(home, cwd)

	writeFile(t, filepath.Join(home, ".pizzapi", "AGENTS.md"), "global")
	writeFile(t, filepath.Join(repo, ".claude", "CLAUDE.md"), "repo-claude")
	writeFile(t, filepath.Join(repo, "apps", ".pizzapi", "AGENTS.md"), "apps-pizzapi")
	writeFile(t, filepath.Join(cwd, "CLAUDE.md"), "cwd-root")

	got, err := locator.DiscoverInstructionDocs()
	if err != nil {
		t.Fatalf("DiscoverInstructionDocs(): %v", err)
	}

	wantPaths := []string{
		filepath.Join(cwd, "CLAUDE.md"),
		filepath.Join(repo, "apps", ".pizzapi", "AGENTS.md"),
		filepath.Join(repo, ".claude", "CLAUDE.md"),
		filepath.Join(home, ".pizzapi", "AGENTS.md"),
	}
	if len(got) != len(wantPaths) {
		t.Fatalf("expected %d docs, got %d: %#v", len(wantPaths), len(got), got)
	}
	for i, want := range wantPaths {
		if got[i].Path != want {
			t.Fatalf("doc %d path mismatch: got %q want %q", i, got[i].Path, want)
		}
	}
	if got[0].Content != "cwd-root" {
		t.Fatalf("expected doc content to be loaded, got %#v", got[0])
	}
}

func TestDiscoverInstructionDocsDedupesHomeCandidatesWhenCwdLivesUnderHome(t *testing.T) {
	homeRoot := t.TempDir()
	home := filepath.Join(homeRoot, "home")
	cwd := filepath.Join(home, "src", "repo")
	locator := NewLocator(home, cwd)

	// Place .git at home so the ancestor walk (which visits home) overlaps
	// with the global home candidates — triggering the dedup path.
	makeGitRepo(t, home)

	writeFile(t, filepath.Join(home, ".pizzapi", "AGENTS.md"), "global")

	got, err := locator.DiscoverInstructionDocs()
	if err != nil {
		t.Fatalf("DiscoverInstructionDocs(): %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 deduped doc, got %d: %#v", len(got), got)
	}
	if got[0].Path != filepath.Join(home, ".pizzapi", "AGENTS.md") {
		t.Fatalf("unexpected deduped doc path: %#v", got[0])
	}
}

func TestConfigPathsPrecedence(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	cwd := filepath.Join(t.TempDir(), "repo")
	locator := NewLocator(home, cwd)

	got := locator.ConfigPaths()

	wantPizzaPiConfig := []PathCandidate{
		{Path: filepath.Join(cwd, ".pizzapi", "config.json"), Family: FamilyPizzaPi, Scope: ScopeProject, Priority: 1},
		{Path: filepath.Join(home, ".pizzapi", "config.json"), Family: FamilyPizzaPi, Scope: ScopeGlobal, Priority: 2},
	}
	if !reflect.DeepEqual(got.PizzaPiConfig, wantPizzaPiConfig) {
		t.Fatalf("PizzaPiConfig mismatch\n got: %#v\nwant: %#v", got.PizzaPiConfig, wantPizzaPiConfig)
	}

	wantPizzaPiSettings := []PathCandidate{
		{Path: filepath.Join(cwd, ".pizzapi", "settings.json"), Family: FamilyPizzaPi, Scope: ScopeProject, Priority: 1},
		{Path: filepath.Join(home, ".pizzapi", "settings.json"), Family: FamilyPizzaPi, Scope: ScopeGlobal, Priority: 2},
	}
	if !reflect.DeepEqual(got.PizzaPiSettings, wantPizzaPiSettings) {
		t.Fatalf("PizzaPiSettings mismatch\n got: %#v\nwant: %#v", got.PizzaPiSettings, wantPizzaPiSettings)
	}

	wantClaudeSettings := []PathCandidate{
		{Path: filepath.Join(cwd, ".claude", "settings.local.json"), Family: FamilyClaude, Scope: ScopeProject, Priority: 1},
		{Path: filepath.Join(cwd, ".claude", "settings.json"), Family: FamilyClaude, Scope: ScopeProject, Priority: 2},
		{Path: filepath.Join(home, ".claude", "settings.json"), Family: FamilyClaude, Scope: ScopeGlobal, Priority: 3},
	}
	if !reflect.DeepEqual(got.ClaudeSettings, wantClaudeSettings) {
		t.Fatalf("ClaudeSettings mismatch\n got: %#v\nwant: %#v", got.ClaudeSettings, wantClaudeSettings)
	}
}

// --- New tests for Dish 004 ---

// TestGitRootFound verifies GitRoot returns the directory containing .git.
func TestGitRootFound(t *testing.T) {
	base := t.TempDir()
	repo := filepath.Join(base, "repo")
	sub := filepath.Join(repo, "pkg", "foo")
	makeGitRepo(t, repo)
	mustMkdirAll(t, sub)

	locator := NewLocator(filepath.Join(base, "home"), sub)
	got := locator.GitRoot()
	if got != repo {
		t.Fatalf("GitRoot() = %q, want %q", got, repo)
	}
}

// TestGitRootFoundAtCwd verifies GitRoot returns cwd itself when .git is there.
func TestGitRootFoundAtCwd(t *testing.T) {
	base := t.TempDir()
	repo := filepath.Join(base, "repo")
	makeGitRepo(t, repo)
	mustMkdirAll(t, repo)

	locator := NewLocator(filepath.Join(base, "home"), repo)
	got := locator.GitRoot()
	if got != repo {
		t.Fatalf("GitRoot() = %q, want %q", got, repo)
	}
}

// TestGitRootNotFound verifies GitRoot returns "" when not in a git repo.
func TestGitRootNotFound(t *testing.T) {
	base := t.TempDir()
	cwd := filepath.Join(base, "no-git", "sub")
	mustMkdirAll(t, cwd)

	locator := NewLocator(filepath.Join(base, "home"), cwd)
	got := locator.GitRoot()
	if got != "" {
		t.Fatalf("GitRoot() = %q, want empty string (no git repo)", got)
	}
}

// TestAncestorWalkStopsAtGitBoundary verifies that instruction docs above the git
// root are not discovered via the project-scope walk.
func TestAncestorWalkStopsAtGitBoundary(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, "home")
	repo := filepath.Join(base, "workspace", "repo")
	cwd := filepath.Join(repo, "sub", "pkg")
	aboveRepo := filepath.Join(base, "workspace") // outside git root

	makeGitRepo(t, repo)
	mustMkdirAll(t, cwd)

	// Doc inside git root — should be discovered.
	writeFile(t, filepath.Join(repo, "AGENTS.md"), "inside-repo")
	// Doc above git root in ancestor chain — must NOT appear via project walk.
	writeFile(t, filepath.Join(aboveRepo, "AGENTS.md"), "outside-repo")

	locator := NewLocator(home, cwd)
	got, err := locator.DiscoverInstructionDocs()
	if err != nil {
		t.Fatalf("DiscoverInstructionDocs(): %v", err)
	}

	for _, doc := range got {
		if doc.Path == filepath.Join(aboveRepo, "AGENTS.md") {
			t.Fatalf("doc above git root was discovered: %#v", doc)
		}
	}

	var found bool
	for _, doc := range got {
		if doc.Path == filepath.Join(repo, "AGENTS.md") {
			found = true
		}
	}
	if !found {
		t.Fatalf("doc inside git root was NOT discovered; got: %#v", got)
	}
}

// TestSYSTEMMdDiscoveredInInstructionDocs verifies SYSTEM.md is included in candidates.
func TestSYSTEMMdDiscoveredInInstructionDocs(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, "home")
	repo := filepath.Join(base, "repo")
	makeGitRepo(t, repo)

	writeFile(t, filepath.Join(repo, "SYSTEM.md"), "system-prompt")

	locator := NewLocator(home, repo)
	got, err := locator.DiscoverInstructionDocs()
	if err != nil {
		t.Fatalf("DiscoverInstructionDocs(): %v", err)
	}

	var found bool
	for _, doc := range got {
		if doc.Path == filepath.Join(repo, "SYSTEM.md") {
			found = true
			if doc.Content != "system-prompt" {
				t.Fatalf("SYSTEM.md content mismatch: %q", doc.Content)
			}
		}
	}
	if !found {
		t.Fatalf("SYSTEM.md not discovered; got: %#v", got)
	}
}

// TestSYSTEMMdInSubdirDiscovered verifies .pizzapi/SYSTEM.md and .claude/SYSTEM.md are candidates.
func TestSYSTEMMdInSubdirDiscovered(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, "home")
	repo := filepath.Join(base, "repo")
	makeGitRepo(t, repo)

	writeFile(t, filepath.Join(repo, ".pizzapi", "SYSTEM.md"), "pizzapi-system")
	writeFile(t, filepath.Join(repo, ".claude", "SYSTEM.md"), "claude-system")

	locator := NewLocator(home, repo)
	got, err := locator.DiscoverInstructionDocs()
	if err != nil {
		t.Fatalf("DiscoverInstructionDocs(): %v", err)
	}

	wantPaths := map[string]bool{
		filepath.Join(repo, ".pizzapi", "SYSTEM.md"): false,
		filepath.Join(repo, ".claude", "SYSTEM.md"):  false,
	}
	for _, doc := range got {
		if _, ok := wantPaths[doc.Path]; ok {
			wantPaths[doc.Path] = true
		}
	}
	for p, found := range wantPaths {
		if !found {
			t.Errorf("expected %q to be discovered but it was not; got: %#v", p, got)
		}
	}
}

// TestGEMINIMdDiscoveredInInstructionDocs verifies GEMINI.md is included in candidates.
func TestGEMINIMdDiscoveredInInstructionDocs(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, "home")
	repo := filepath.Join(base, "repo")
	makeGitRepo(t, repo)

	writeFile(t, filepath.Join(repo, "GEMINI.md"), "gemini-context")

	locator := NewLocator(home, repo)
	got, err := locator.DiscoverInstructionDocs()
	if err != nil {
		t.Fatalf("DiscoverInstructionDocs(): %v", err)
	}

	var found bool
	for _, doc := range got {
		if doc.Path == filepath.Join(repo, "GEMINI.md") {
			found = true
			if doc.Content != "gemini-context" {
				t.Fatalf("GEMINI.md content mismatch: %q", doc.Content)
			}
		}
	}
	if !found {
		t.Fatalf("GEMINI.md not discovered; got: %#v", got)
	}
}

// TestGEMINIMdInSubdirDiscovered verifies .pizzapi/GEMINI.md and .claude/GEMINI.md are candidates.
func TestGEMINIMdInSubdirDiscovered(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, "home")
	repo := filepath.Join(base, "repo")
	makeGitRepo(t, repo)

	writeFile(t, filepath.Join(repo, ".pizzapi", "GEMINI.md"), "pizzapi-gemini")
	writeFile(t, filepath.Join(repo, ".claude", "GEMINI.md"), "claude-gemini")

	locator := NewLocator(home, repo)
	got, err := locator.DiscoverInstructionDocs()
	if err != nil {
		t.Fatalf("DiscoverInstructionDocs(): %v", err)
	}

	wantPaths := map[string]bool{
		filepath.Join(repo, ".pizzapi", "GEMINI.md"): false,
		filepath.Join(repo, ".claude", "GEMINI.md"):  false,
	}
	for _, doc := range got {
		if _, ok := wantPaths[doc.Path]; ok {
			wantPaths[doc.Path] = true
		}
	}
	for p, found := range wantPaths {
		if !found {
			t.Errorf("expected %q to be discovered but it was not; got: %#v", p, got)
		}
	}
}

// TestPathsOutsideGitRootExcludedFromProjectWalk verifies that ancestor
// directories above the git root are excluded from the project-scope walk.
func TestPathsOutsideGitRootExcludedFromProjectWalk(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, "home")
	outsideDir := filepath.Join(base, "outside")
	repo := filepath.Join(base, "outside", "repo") // repo is child of outsideDir
	cwd := filepath.Join(repo, "src")

	makeGitRepo(t, repo)
	mustMkdirAll(t, cwd)

	// This file is above the git root — must not appear as a project-scope doc.
	writeFile(t, filepath.Join(outsideDir, "AGENTS.md"), "above-git-root")
	// This file is inside the git root — must appear.
	writeFile(t, filepath.Join(repo, "AGENTS.md"), "inside-git-root")

	locator := NewLocator(home, cwd)
	got, err := locator.DiscoverInstructionDocs()
	if err != nil {
		t.Fatalf("DiscoverInstructionDocs(): %v", err)
	}

	for _, doc := range got {
		if doc.Path == filepath.Join(outsideDir, "AGENTS.md") && doc.Scope == ScopeProject {
			t.Fatalf("doc above git root was included as project-scope: %#v", doc)
		}
	}

	var insideFound bool
	for _, doc := range got {
		if doc.Path == filepath.Join(repo, "AGENTS.md") {
			insideFound = true
		}
	}
	if !insideFound {
		t.Fatalf("doc inside git root was not discovered; got: %#v", got)
	}
}

// TestGlobalSYSTEMMdDiscovered verifies SYSTEM.md in homeDir subdirs is a global candidate.
func TestGlobalSYSTEMMdDiscovered(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, "home")
	repo := filepath.Join(base, "repo")
	makeGitRepo(t, repo)

	writeFile(t, filepath.Join(home, ".pizzapi", "SYSTEM.md"), "global-system")
	writeFile(t, filepath.Join(home, ".claude", "SYSTEM.md"), "global-claude-system")

	locator := NewLocator(home, repo)
	got, err := locator.DiscoverInstructionDocs()
	if err != nil {
		t.Fatalf("DiscoverInstructionDocs(): %v", err)
	}

	wantPaths := map[string]bool{
		filepath.Join(home, ".pizzapi", "SYSTEM.md"): false,
		filepath.Join(home, ".claude", "SYSTEM.md"):  false,
	}
	for _, doc := range got {
		if _, ok := wantPaths[doc.Path]; ok {
			wantPaths[doc.Path] = true
			if doc.Scope != ScopeGlobal {
				t.Errorf("expected %q to be global scope, got %q", doc.Path, doc.Scope)
			}
		}
	}
	for p, found := range wantPaths {
		if !found {
			t.Errorf("expected global %q to be discovered; got: %#v", p, got)
		}
	}
}

// TestGlobalGEMINIMdDiscovered verifies GEMINI.md in homeDir subdirs is a global candidate.
func TestGlobalGEMINIMdDiscovered(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, "home")
	repo := filepath.Join(base, "repo")
	makeGitRepo(t, repo)

	writeFile(t, filepath.Join(home, ".pizzapi", "GEMINI.md"), "global-gemini")
	writeFile(t, filepath.Join(home, ".claude", "GEMINI.md"), "global-claude-gemini")

	locator := NewLocator(home, repo)
	got, err := locator.DiscoverInstructionDocs()
	if err != nil {
		t.Fatalf("DiscoverInstructionDocs(): %v", err)
	}

	wantPaths := map[string]bool{
		filepath.Join(home, ".pizzapi", "GEMINI.md"): false,
		filepath.Join(home, ".claude", "GEMINI.md"):  false,
	}
	for _, doc := range got {
		if _, ok := wantPaths[doc.Path]; ok {
			wantPaths[doc.Path] = true
			if doc.Scope != ScopeGlobal {
				t.Errorf("expected %q to be global scope, got %q", doc.Path, doc.Scope)
			}
		}
	}
	for p, found := range wantPaths {
		if !found {
			t.Errorf("expected global %q to be discovered; got: %#v", p, got)
		}
	}
}

// TestWalkUpDirsStopsAtGitRoot directly tests the walkUpDirs helper.
func TestWalkUpDirsStopsAtGitRoot(t *testing.T) {
	base := t.TempDir()
	repo := filepath.Join(base, "repo")
	cwd := filepath.Join(repo, "a", "b", "c")
	mustMkdirAll(t, cwd)

	got := walkUpDirs(cwd, repo)
	want := []string{
		filepath.Join(repo, "a", "b", "c"),
		filepath.Join(repo, "a", "b"),
		filepath.Join(repo, "a"),
		repo,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("walkUpDirs() = %#v\nwant:         %#v", got, want)
	}
}

// TestWalkUpDirsNoStopWalksToRoot verifies unbounded walk when stopAt is "".
func TestWalkUpDirsNoStopWalksToRoot(t *testing.T) {
	dirs := walkUpDirs("/a/b/c", "")
	// Should include /a/b/c, /a/b, /a, /
	if len(dirs) < 4 {
		t.Fatalf("expected at least 4 dirs for /a/b/c, got %d: %v", len(dirs), dirs)
	}
	if dirs[0] != "/a/b/c" {
		t.Fatalf("first dir should be start, got %q", dirs[0])
	}
	if dirs[len(dirs)-1] != "/" {
		t.Fatalf("last dir should be /, got %q", dirs[len(dirs)-1])
	}
}

// TestDeduplicationWithGitRoot verifies that when the ancestor walk visits a path
// also present in the global candidates, it appears exactly once.
func TestDeduplicationWithGitRoot(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, "home")
	// cwd is inside home, and home is the git root — so the walk visits home
	// and encounters home/.pizzapi/AGENTS.md as a project candidate.
	// The global candidates also include home/.pizzapi/AGENTS.md.
	// Deduplication must keep it exactly once.
	cwd := filepath.Join(home, "src", "project")
	makeGitRepo(t, home) // home itself is the git root
	mustMkdirAll(t, cwd)

	writeFile(t, filepath.Join(home, ".pizzapi", "AGENTS.md"), "dedup-target")

	locator := NewLocator(home, cwd)
	got, err := locator.DiscoverInstructionDocs()
	if err != nil {
		t.Fatalf("DiscoverInstructionDocs(): %v", err)
	}

	count := 0
	for _, doc := range got {
		if doc.Path == filepath.Join(home, ".pizzapi", "AGENTS.md") {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected AGENTS.md to appear exactly once, got %d; docs: %#v", count, got)
	}
}

// TestGitRootFileVsDir verifies that a regular file named .git is also accepted
// (e.g., git worktree .git files).
func TestGitRootFileVsDir(t *testing.T) {
	base := t.TempDir()
	repo := filepath.Join(base, "repo")
	mustMkdirAll(t, repo)
	// Write .git as a file (like git worktrees do)
	if err := os.WriteFile(filepath.Join(repo, ".git"), []byte("gitdir: ../real/.git"), 0o644); err != nil {
		t.Fatalf("write .git file: %v", err)
	}

	locator := NewLocator(filepath.Join(base, "home"), repo)
	got := locator.GitRoot()
	if got != repo {
		t.Fatalf("GitRoot() = %q, want %q (should accept .git file, not just dir)", got, repo)
	}
}
