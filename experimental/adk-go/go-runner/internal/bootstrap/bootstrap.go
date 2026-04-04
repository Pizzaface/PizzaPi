package bootstrap

import (
	"os"
	"strings"

	"github.com/pizzaface/pizzapi/experimental/adk-go/runtime/compat"
	"github.com/pizzaface/pizzapi/experimental/adk-go/runtime/mcpconfig"
)

type Session struct {
	SystemPrompt  string
	MCPConfigPath string
	Cleanup       func()
}

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
