package compat

import (
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

	writeFile(t, filepath.Join(home, ".claude", "skills", "shared", "SKILL.md"), "# global claude skill")
	writeFile(t, filepath.Join(cwd, ".claude", "skills", "shared.md"), "# project claude skill")
	writeFile(t, filepath.Join(cwd, ".pizzapi", "skills", "shared", "SKILL.md"), "# project pizzapi skill")
	writeFile(t, filepath.Join(cwd, ".claude", "skills", "solo.md"), "# solo")

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
	if got[1].Name != "solo" || got[1].Path != filepath.Join(cwd, ".claude", "skills", "solo.md") {
		t.Fatalf("solo skill mismatch: %#v", got[1])
	}
}

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
