package compat

import (
	"fmt"
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
	FamilyCodex   Family = "codex"

	ScopeProject Scope = "project"
	ScopeGlobal  Scope = "global"
)

// LocatorConfig holds optional configuration for a Locator.
type LocatorConfig struct {
	// SkillsDisabled mirrors the --no-skills flag: when true, DiscoverSkills
	// returns an empty slice without scanning the filesystem.
	SkillsDisabled bool
}

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
	// Description is populated from SKILL.md frontmatter for skill resources.
	Description string
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
	Config  LocatorConfig
}

// NewLocator returns a normalized locator for deterministic path resolution in tests
// and runtime code. An optional LocatorConfig may be passed as the third argument.
func NewLocator(homeDir, cwd string, cfgs ...LocatorConfig) Locator {
	var cfg LocatorConfig
	if len(cfgs) > 0 {
		cfg = cfgs[0]
	}
	return Locator{
		HomeDir: filepath.Clean(homeDir),
		Cwd:     filepath.Clean(cwd),
		Config:  cfg,
	}
}

// GitRoot finds the nearest ancestor directory (inclusive of l.Cwd) that contains
// a .git entry (file or directory). Returns empty string if not in a git repo.
func (l Locator) GitRoot() string {
	current := filepath.Clean(l.Cwd)
	for {
		if _, err := os.Stat(filepath.Join(current, ".git")); err == nil {
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			// reached filesystem root without finding .git
			return ""
		}
		current = parent
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
// Includes .pizzapi, .claude, and .codex families for cross-tool compatibility.
func (l Locator) SkillRoots() []PathCandidate {
	return []PathCandidate{
		{Path: filepath.Join(l.Cwd, ".pizzapi", "skills"), Family: FamilyPizzaPi, Scope: ScopeProject, Priority: 1},
		{Path: filepath.Join(l.Cwd, ".claude", "skills"), Family: FamilyClaude, Scope: ScopeProject, Priority: 2},
		{Path: filepath.Join(l.Cwd, ".codex", "skills"), Family: FamilyCodex, Scope: ScopeProject, Priority: 3},
		{Path: filepath.Join(l.HomeDir, ".pizzapi", "skills"), Family: FamilyPizzaPi, Scope: ScopeGlobal, Priority: 4},
		{Path: filepath.Join(l.HomeDir, ".claude", "skills"), Family: FamilyClaude, Scope: ScopeGlobal, Priority: 5},
		{Path: filepath.Join(l.HomeDir, ".codex", "skills"), Family: FamilyCodex, Scope: ScopeGlobal, Priority: 6},
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
// Skills must have a description in their frontmatter to be included.
// When Config.SkillsDisabled is true, returns an empty slice immediately.
func (l Locator) DiscoverSkills() ([]NamedResource, error) {
	if l.Config.SkillsDisabled {
		return []NamedResource{}, nil
	}
	return discoverSkillResources(l.SkillRoots())
}

// DiscoverInstructionDocs walks project ancestors up to the git root (or filesystem
// root if not in a git repo), then appends global home-dir candidates. Duplicate
// paths are deduplicated keeping the first (highest-precedence) occurrence.
func (l Locator) DiscoverInstructionDocs() ([]InstructionDoc, error) {
	candidates := instructionCandidates(l.HomeDir, l.Cwd, l.GitRoot())
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

// instructionFileSpecs lists the per-directory instruction file patterns in
// highest-to-lowest precedence order within a directory.
var instructionFileSpecs = []struct {
	rel    string
	family Family
}{
	{rel: filepath.Join(".pizzapi", "AGENTS.md"), family: FamilyPizzaPi},
	{rel: filepath.Join(".pizzapi", "CLAUDE.md"), family: FamilyPizzaPi},
	{rel: filepath.Join(".pizzapi", "GEMINI.md"), family: FamilyPizzaPi},
	{rel: filepath.Join(".pizzapi", "SYSTEM.md"), family: FamilyPizzaPi},
	{rel: filepath.Join(".claude", "AGENTS.md"), family: FamilyClaude},
	{rel: filepath.Join(".claude", "CLAUDE.md"), family: FamilyClaude},
	{rel: filepath.Join(".claude", "GEMINI.md"), family: FamilyClaude},
	{rel: filepath.Join(".claude", "SYSTEM.md"), family: FamilyClaude},
	{rel: "AGENTS.md", family: FamilyPizzaPi},
	{rel: "CLAUDE.md", family: FamilyClaude},
	{rel: "GEMINI.md", family: FamilyClaude},
	{rel: "SYSTEM.md", family: FamilyPizzaPi},
}

// globalInstructionFileSpecs lists the home-dir instruction file patterns for
// the global (user-level) candidates.
var globalInstructionFileSpecs = []struct {
	rel    string
	family Family
}{
	{rel: filepath.Join(".pizzapi", "AGENTS.md"), family: FamilyPizzaPi},
	{rel: filepath.Join(".pizzapi", "CLAUDE.md"), family: FamilyPizzaPi},
	{rel: filepath.Join(".pizzapi", "GEMINI.md"), family: FamilyPizzaPi},
	{rel: filepath.Join(".pizzapi", "SYSTEM.md"), family: FamilyPizzaPi},
	{rel: filepath.Join(".claude", "AGENTS.md"), family: FamilyClaude},
	{rel: filepath.Join(".claude", "CLAUDE.md"), family: FamilyClaude},
	{rel: filepath.Join(".claude", "GEMINI.md"), family: FamilyClaude},
	{rel: filepath.Join(".claude", "SYSTEM.md"), family: FamilyClaude},
}

func instructionCandidates(homeDir, cwd, gitRoot string) []PathCandidate {
	var candidates []PathCandidate
	priority := 1

	// Project-scope: walk from cwd up to gitRoot (inclusive). If gitRoot is ""
	// (not in a git repo), walk to the filesystem root (backward compatible).
	for _, dir := range walkUpDirs(cwd, gitRoot) {
		for _, spec := range instructionFileSpecs {
			candidates = append(candidates, PathCandidate{
				Path:     filepath.Join(dir, spec.rel),
				Family:   spec.family,
				Scope:    ScopeProject,
				Priority: priority,
			})
			priority++
		}
	}

	// Global-scope: home-dir candidates appended after all project candidates.
	for _, spec := range globalInstructionFileSpecs {
		candidates = append(candidates, PathCandidate{
			Path:     filepath.Join(homeDir, spec.rel),
			Family:   spec.family,
			Scope:    ScopeGlobal,
			Priority: priority,
		})
		priority++
	}

	return candidates
}

// discoverSkillResources scans skill roots, reads frontmatter from each skill
// file, and returns only skills that have a non-empty description. When two
// roots provide a skill with the same name the first (highest-precedence) entry
// wins and a warning is emitted to stderr.
func discoverSkillResources(roots []PathCandidate) ([]NamedResource, error) {
	// seen maps canonical skill name → the path that claimed it first.
	seen := map[string]string{}
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
			name, path, ok := resolveResourceEntry(root.Path, entry, true)
			if !ok {
				continue
			}
			content, err := os.ReadFile(path)
			if err != nil {
				if errorsIsNotExist(err) {
					continue
				}
				return nil, err
			}
			fmName, description := parseSkillFrontmatter(string(content))
			if fmName != "" {
				name = fmName
			}
			if description == "" {
				// Skills without a description are excluded per Pi semantics.
				continue
			}
			if prevPath, exists := seen[name]; exists {
				fmt.Fprintf(os.Stderr,
					"compat: skill %q collision: keeping %q, ignoring %q\n",
					name, prevPath, path)
				continue
			}
			seen[name] = path
			resources = append(resources, NamedResource{
				Name:        name,
				Path:        path,
				Family:      root.Family,
				Scope:       root.Scope,
				Priority:    root.Priority,
				Description: description,
			})
		}
	}
	return resources, nil
}

// parseSkillFrontmatter extracts name and description from YAML-style frontmatter
// delimited by "---" lines at the start of the content. Fields not present
// in the frontmatter are returned as empty strings.
func parseSkillFrontmatter(content string) (name, description string) {
	lines := strings.Split(content, "\n")
	if len(lines) < 2 || strings.TrimSpace(lines[0]) != "---" {
		return "", ""
	}
	for i := 1; i < len(lines); i++ {
		line := lines[i]
		if strings.TrimSpace(line) == "---" {
			break
		}
		if after, ok := strings.CutPrefix(line, "name:"); ok {
			name = strings.TrimSpace(after)
		}
		if after, ok := strings.CutPrefix(line, "description:"); ok {
			description = strings.TrimSpace(after)
		}
	}
	return name, description
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

// walkUpDirs returns every directory from start up to and including stopAt.
// If stopAt is "" the walk continues to the filesystem root (/ on Unix).
// The returned slice is ordered from deepest (start) to shallowest (stopAt or /).
func walkUpDirs(start, stopAt string) []string {
	dirs := []string{}
	current := filepath.Clean(start)
	stopAt = filepath.Clean(stopAt)
	for {
		dirs = append(dirs, current)
		// Stop when we've reached the designated boundary.
		if stopAt != "." && current == stopAt {
			break
		}
		parent := filepath.Dir(current)
		if parent == current {
			// reached filesystem root
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
