package compat

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Family identifies which on-disk convention a resource came from.
type Family string

// Scope identifies whether a resource is project-local or global/user-level.
type Scope string

const (
	FamilyPizzaPi Family = "pizzapi"
	FamilyClaude  Family = "claude"

	ScopeProject Scope = "project"
	ScopeGlobal  Scope = "global"
)

// PathCandidate describes a candidate path in highest-precedence-first order.
type PathCandidate struct {
	Path     string
	Family   Family
	Scope    Scope
	Priority int
}

// NamedResource is a deduplicated agent or skill discovered from disk.
type NamedResource struct {
	Name     string
	Path     string
	Family   Family
	Scope    Scope
	Priority int
}

// InstructionDoc is a discovered instruction document with file contents loaded.
type InstructionDoc struct {
	Path     string
	Family   Family
	Scope    Scope
	Priority int
	Content  string
}

// ConfigSet groups config/settings candidates in highest-precedence-first order.
type ConfigSet struct {
	PizzaPiConfig   []PathCandidate
	PizzaPiSettings []PathCandidate
	ClaudeSettings  []PathCandidate
}

// Locator resolves Claude/PizzaPi compatibility paths relative to a home dir and cwd.
type Locator struct {
	HomeDir string
	Cwd     string
}

// NewLocator returns a normalized locator for deterministic path resolution in tests and runtime code.
func NewLocator(homeDir, cwd string) Locator {
	return Locator{
		HomeDir: filepath.Clean(homeDir),
		Cwd:     filepath.Clean(cwd),
	}
}

// AgentRoots returns agent search roots in precedence order.
func (l Locator) AgentRoots() []PathCandidate {
	return []PathCandidate{
		{Path: filepath.Join(l.Cwd, ".pizzapi", "agents"), Family: FamilyPizzaPi, Scope: ScopeProject, Priority: 1},
		{Path: filepath.Join(l.Cwd, ".claude", "agents"), Family: FamilyClaude, Scope: ScopeProject, Priority: 2},
		{Path: filepath.Join(l.HomeDir, ".pizzapi", "agents"), Family: FamilyPizzaPi, Scope: ScopeGlobal, Priority: 3},
		{Path: filepath.Join(l.HomeDir, ".claude", "agents"), Family: FamilyClaude, Scope: ScopeGlobal, Priority: 4},
	}
}

// SkillRoots returns skill search roots in precedence order.
func (l Locator) SkillRoots() []PathCandidate {
	return []PathCandidate{
		{Path: filepath.Join(l.Cwd, ".pizzapi", "skills"), Family: FamilyPizzaPi, Scope: ScopeProject, Priority: 1},
		{Path: filepath.Join(l.Cwd, ".claude", "skills"), Family: FamilyClaude, Scope: ScopeProject, Priority: 2},
		{Path: filepath.Join(l.HomeDir, ".pizzapi", "skills"), Family: FamilyPizzaPi, Scope: ScopeGlobal, Priority: 3},
		{Path: filepath.Join(l.HomeDir, ".claude", "skills"), Family: FamilyClaude, Scope: ScopeGlobal, Priority: 4},
	}
}

// ConfigPaths returns config/settings candidates in merge precedence order.
func (l Locator) ConfigPaths() ConfigSet {
	return ConfigSet{
		PizzaPiConfig: []PathCandidate{
			{Path: filepath.Join(l.Cwd, ".pizzapi", "config.json"), Family: FamilyPizzaPi, Scope: ScopeProject, Priority: 1},
			{Path: filepath.Join(l.HomeDir, ".pizzapi", "config.json"), Family: FamilyPizzaPi, Scope: ScopeGlobal, Priority: 2},
		},
		PizzaPiSettings: []PathCandidate{
			{Path: filepath.Join(l.Cwd, ".pizzapi", "settings.json"), Family: FamilyPizzaPi, Scope: ScopeProject, Priority: 1},
			{Path: filepath.Join(l.HomeDir, ".pizzapi", "settings.json"), Family: FamilyPizzaPi, Scope: ScopeGlobal, Priority: 2},
		},
		ClaudeSettings: []PathCandidate{
			{Path: filepath.Join(l.Cwd, ".claude", "settings.local.json"), Family: FamilyClaude, Scope: ScopeProject, Priority: 1},
			{Path: filepath.Join(l.Cwd, ".claude", "settings.json"), Family: FamilyClaude, Scope: ScopeProject, Priority: 2},
			{Path: filepath.Join(l.HomeDir, ".claude", "settings.json"), Family: FamilyClaude, Scope: ScopeGlobal, Priority: 3},
		},
	}
}

// DiscoverAgents scans agent roots and keeps the first resource for each name.
func (l Locator) DiscoverAgents() ([]NamedResource, error) {
	return discoverNamedResources(l.AgentRoots(), false)
}

// DiscoverSkills scans skill roots and supports both <name>.md and <name>/SKILL.md layouts.
func (l Locator) DiscoverSkills() ([]NamedResource, error) {
	return discoverNamedResources(l.SkillRoots(), true)
}

// DiscoverInstructionDocs walks project ancestors first, then global dirs, loading any instruction docs that exist.
func (l Locator) DiscoverInstructionDocs() ([]InstructionDoc, error) {
	candidates := instructionCandidates(l.HomeDir, l.Cwd)
	docs := make([]InstructionDoc, 0, len(candidates))
	seen := map[string]struct{}{}
	for _, candidate := range candidates {
		normalized := filepath.Clean(candidate.Path)
		if _, ok := seen[normalized]; ok {
			continue
		}
		content, err := os.ReadFile(normalized)
		if err != nil {
			if errorsIsNotExist(err) {
				continue
			}
			return nil, err
		}
		seen[normalized] = struct{}{}
		docs = append(docs, InstructionDoc{
			Path:     normalized,
			Family:   candidate.Family,
			Scope:    candidate.Scope,
			Priority: candidate.Priority,
			Content:  string(content),
		})
	}
	return docs, nil
}

func instructionCandidates(homeDir, cwd string) []PathCandidate {
	var candidates []PathCandidate
	priority := 1
	for _, dir := range walkUpDirs(cwd) {
		for _, rel := range []struct {
			path   string
			family Family
		}{
			{path: filepath.Join(".pizzapi", "AGENTS.md"), family: FamilyPizzaPi},
			{path: filepath.Join(".pizzapi", "CLAUDE.md"), family: FamilyPizzaPi},
			{path: filepath.Join(".claude", "AGENTS.md"), family: FamilyClaude},
			{path: filepath.Join(".claude", "CLAUDE.md"), family: FamilyClaude},
			{path: "AGENTS.md", family: FamilyPizzaPi},
			{path: "CLAUDE.md", family: FamilyClaude},
		} {
			candidates = append(candidates, PathCandidate{
				Path:     filepath.Join(dir, rel.path),
				Family:   rel.family,
				Scope:    ScopeProject,
				Priority: priority,
			})
			priority++
		}
	}
	for _, rel := range []struct {
		path   string
		family Family
	}{
		{path: filepath.Join(".pizzapi", "AGENTS.md"), family: FamilyPizzaPi},
		{path: filepath.Join(".pizzapi", "CLAUDE.md"), family: FamilyPizzaPi},
		{path: filepath.Join(".claude", "AGENTS.md"), family: FamilyClaude},
		{path: filepath.Join(".claude", "CLAUDE.md"), family: FamilyClaude},
	} {
		candidates = append(candidates, PathCandidate{
			Path:     filepath.Join(homeDir, rel.path),
			Family:   rel.family,
			Scope:    ScopeGlobal,
			Priority: priority,
		})
		priority++
	}
	return candidates
}

func discoverNamedResources(roots []PathCandidate, allowSkillDirs bool) ([]NamedResource, error) {
	seen := map[string]struct{}{}
	resources := []NamedResource{}
	for _, root := range roots {
		entries, err := os.ReadDir(root.Path)
		if err != nil {
			if errorsIsNotExist(err) {
				continue
			}
			return nil, err
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			name, path, ok := resolveResourceEntry(root.Path, entry, allowSkillDirs)
			if !ok {
				continue
			}
			if _, exists := seen[name]; exists {
				continue
			}
			seen[name] = struct{}{}
			resources = append(resources, NamedResource{
				Name:     name,
				Path:     path,
				Family:   root.Family,
				Scope:    root.Scope,
				Priority: root.Priority,
			})
		}
	}
	return resources, nil
}

func resolveResourceEntry(root string, entry fs.DirEntry, allowSkillDirs bool) (name string, path string, ok bool) {
	fullPath := filepath.Join(root, entry.Name())
	if entry.Type().IsRegular() && strings.HasSuffix(strings.ToLower(entry.Name()), ".md") {
		return strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())), fullPath, true
	}
	if allowSkillDirs && entry.IsDir() {
		skillPath := filepath.Join(fullPath, "SKILL.md")
		info, err := os.Stat(skillPath)
		if err == nil && !info.IsDir() {
			return entry.Name(), skillPath, true
		}
		if err != nil && !errorsIsNotExist(err) {
			return "", "", false
		}
	}
	return "", "", false
}

func walkUpDirs(start string) []string {
	dirs := []string{}
	current := filepath.Clean(start)
	for {
		dirs = append(dirs, current)
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	return dirs
}

func mkdirAll(path string) error {
	return os.MkdirAll(path, 0o755)
}

func writeTextFile(path string, content []byte) error {
	return os.WriteFile(path, content, 0o644)
}

func errorsIsNotExist(err error) bool {
	return os.IsNotExist(err)
}
