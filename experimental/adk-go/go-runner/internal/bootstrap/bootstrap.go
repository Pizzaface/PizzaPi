package bootstrap

import (
	"encoding/json"
	"os"
	"strings"

	"github.com/pizzaface/pizzapi/experimental/adk-go/runtime/compat"
	"github.com/pizzaface/pizzapi/experimental/adk-go/runtime/mcpconfig"
)

// ---------------------------------------------------------------------------
// Session bootstrap (MCP config + system prompt for a new agent session)
// ---------------------------------------------------------------------------

// Session is the resolved bootstrap configuration for a single agent session.
type Session struct {
	SystemPrompt  string
	MCPConfigPath string
	Cleanup       func()
}

// Build resolves the MCP config and system prompt for a new agent session.
// It discovers instruction docs (AGENTS.md, CLAUDE.md) and merges global +
// project MCP server configurations into a temp file consumed by the Claude CLI.
func Build(cwd, homeDir, tempDir string) (Session, error) {
	locator := compat.NewLocator(homeDir, cwd)
	docs, err := locator.DiscoverInstructionDocs()
	if err != nil {
		return Session{}, err
	}

	bootstrap := Session{Cleanup: func() {}}
	if len(docs) > 0 {
		parts := make([]string, 0, len(docs))
		for _, doc := range docs {
			parts = append(parts, strings.TrimSpace(doc.Content))
		}
		bootstrap.SystemPrompt = strings.Join(parts, "\n\n")
	}

	cfgPaths := locator.ConfigPaths()
	globalCfg, err := parseMCPConfigFile(candidatePath(cfgPaths.PizzaPiConfig, compat.ScopeGlobal))
	if err != nil {
		return Session{}, err
	}
	projectCfg, err := parseMCPConfigFile(candidatePath(cfgPaths.PizzaPiConfig, compat.ScopeProject))
	if err != nil {
		return Session{}, err
	}
	merged := mcpconfig.Merge(globalCfg, projectCfg)
	if len(merged.Servers) == 0 {
		return bootstrap, nil
	}

	data, err := merged.MarshalClaudeConfigJSON()
	if err != nil {
		return Session{}, err
	}
	if err := os.MkdirAll(tempDir, 0o755); err != nil {
		return Session{}, err
	}
	file, err := os.CreateTemp(tempDir, "claude-mcp-*.json")
	if err != nil {
		return Session{}, err
	}
	path := file.Name()
	if _, err := file.Write(data); err != nil {
		file.Close()
		_ = os.Remove(path)
		return Session{}, err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return Session{}, err
	}
	bootstrap.MCPConfigPath = path
	bootstrap.Cleanup = func() { _ = os.Remove(path) }
	return bootstrap, nil
}

func candidatePath(candidates []compat.PathCandidate, scope compat.Scope) string {
	for _, candidate := range candidates {
		if candidate.Scope == scope {
			return candidate.Path
		}
	}
	return ""
}

func parseMCPConfigFile(path string) (mcpconfig.Config, error) {
	if path == "" {
		return mcpconfig.Config{}, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return mcpconfig.Config{}, nil
		}
		return mcpconfig.Config{}, err
	}
	return mcpconfig.ParsePizzaPiConfig(data)
}

// ---------------------------------------------------------------------------
// Runner config (hooks + sandbox from PizzaPi config.json)
// ---------------------------------------------------------------------------

// HookEntry is a single hook matcher + script pair within a hook type.
// PizzaPi config.json stores hooks as:
//
//	"hooks": {
//	  "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "script.sh" }] }]
//	}
type HookEntry struct {
	// Matcher is the tool or event pattern this hook applies to (e.g. "Bash", "*").
	Matcher string `json:"matcher"`
	// Hooks are the commands/scripts to execute when the matcher triggers.
	Hooks []HookCommand `json:"hooks"`
}

// HookCommand describes a single executable hook.
type HookCommand struct {
	Type    string `json:"type"`    // "command" is the only type PizzaPi supports today
	Command string `json:"command"` // shell command to execute
}

// SandboxConfig mirrors the "sandbox" section of ~/.pizzapi/config.json.
type SandboxConfig struct {
	// Mode controls overall sandbox behaviour: "off", "restricted", or "permissive".
	Mode string `json:"mode"`
	// AllowedPaths lists filesystem paths the sandbox permits read/write access to.
	AllowedPaths []string `json:"allowedPaths"`
	// BlockedPaths lists filesystem paths the sandbox explicitly denies access to.
	BlockedPaths []string `json:"blockedPaths"`
	// AllowedDomains lists network domains the sandbox permits outbound connections to.
	AllowedDomains []string `json:"allowedDomains"`
	// BlockedDomains lists network domains the sandbox explicitly denies.
	BlockedDomains []string `json:"blockedDomains"`
}

// RunnerConfig is the merged configuration relevant to the Go runner itself
// (hooks, sandbox, system prompt append). MCP servers are handled separately
// by Build via the mcpconfig package.
type RunnerConfig struct {
	// Hooks maps hook-type names (e.g. "PreToolUse") to their ordered entries.
	// Project hooks are only included when the global config enables AllowProjectHooks.
	Hooks map[string][]HookEntry `json:"hooks"`
	// Sandbox contains filesystem and network restrictions for the runner.
	Sandbox SandboxConfig `json:"sandbox"`
	// AppendSystemPrompt is extra text appended to every session's system prompt.
	AppendSystemPrompt string `json:"appendSystemPrompt"`
	// AllowProjectHooks signals whether project-local hook definitions are trusted.
	// This is read from the GLOBAL config only (projects cannot self-authorize).
	AllowProjectHooks bool `json:"allowProjectHooks"`
}

// rawPizzaPiConfig is the full on-disk shape of ~/.pizzapi/config.json.
// Only the fields relevant to RunnerConfig are captured here.
type rawPizzaPiConfig struct {
	Hooks              map[string][]HookEntry `json:"hooks"`
	Sandbox            SandboxConfig          `json:"sandbox"`
	AppendSystemPrompt string                 `json:"appendSystemPrompt"`
	AllowProjectHooks  bool                   `json:"allowProjectHooks"`
}

// LoadConfig reads and merges the global and project-local PizzaPi config.json
// files, returning a RunnerConfig with hooks and sandbox settings.
//
// Merge rules:
//   - Sandbox settings come from the global config only (project cannot override).
//   - AppendSystemPrompt from global and project are joined with "\n\n".
//   - Project hooks are only included when the global config sets AllowProjectHooks=true.
//   - Hook lists are concatenated: global hooks run first, then project hooks.
func LoadConfig(cwd, homeDir string) (RunnerConfig, error) {
	locator := compat.NewLocator(homeDir, cwd)
	cfgPaths := locator.ConfigPaths()

	globalPath := candidatePath(cfgPaths.PizzaPiConfig, compat.ScopeGlobal)
	projectPath := candidatePath(cfgPaths.PizzaPiConfig, compat.ScopeProject)

	globalRaw, err := readRawConfig(globalPath)
	if err != nil {
		return RunnerConfig{}, err
	}
	projectRaw, err := readRawConfig(projectPath)
	if err != nil {
		return RunnerConfig{}, err
	}

	cfg := RunnerConfig{
		Sandbox:           globalRaw.Sandbox, // sandbox from global only
		AllowProjectHooks: globalRaw.AllowProjectHooks,
		Hooks:             make(map[string][]HookEntry),
	}

	// Merge AppendSystemPrompt
	var promptParts []string
	if globalRaw.AppendSystemPrompt != "" {
		promptParts = append(promptParts, globalRaw.AppendSystemPrompt)
	}
	if projectRaw.AppendSystemPrompt != "" {
		promptParts = append(promptParts, projectRaw.AppendSystemPrompt)
	}
	cfg.AppendSystemPrompt = strings.Join(promptParts, "\n\n")

	// Merge hooks: global first, then project (only if allowed).
	for hookType, entries := range globalRaw.Hooks {
		cfg.Hooks[hookType] = append(cfg.Hooks[hookType], entries...)
	}
	if globalRaw.AllowProjectHooks {
		for hookType, entries := range projectRaw.Hooks {
			cfg.Hooks[hookType] = append(cfg.Hooks[hookType], entries...)
		}
	}

	return cfg, nil
}

// readRawConfig parses a PizzaPi config.json file into rawPizzaPiConfig.
// Missing files are treated as an empty config — not an error.
func readRawConfig(path string) (rawPizzaPiConfig, error) {
	if path == "" {
		return rawPizzaPiConfig{}, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return rawPizzaPiConfig{}, nil
		}
		return rawPizzaPiConfig{}, err
	}
	var raw rawPizzaPiConfig
	if err := json.Unmarshal(data, &raw); err != nil {
		return rawPizzaPiConfig{}, err
	}
	return raw, nil
}
