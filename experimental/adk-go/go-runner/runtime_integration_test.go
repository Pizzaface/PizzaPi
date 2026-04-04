package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiscoverRegistrationMetadata(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	cwd := filepath.Join(t.TempDir(), "repo")

	mustWrite := func(path, content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", path, err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}

	mustWrite(filepath.Join(cwd, ".pizzapi", "skills", "local-skill", "SKILL.md"), "---\ndescription: Local skill desc\n---\n# Local Skill\n")
	mustWrite(filepath.Join(home, ".claude", "skills", "global-skill.md"), "# Global skill\nGlobal skill body\n")
	mustWrite(filepath.Join(cwd, ".claude", "agents", "local-agent.md"), "---\ndescription: Local agent desc\n---\n# Local Agent\n")

	meta, err := discoverRegistrationMetadata(cwd, home)
	if err != nil {
		t.Fatalf("discoverRegistrationMetadata: %v", err)
	}

	if len(meta.Roots) != 1 || meta.Roots[0] != cwd {
		t.Fatalf("unexpected roots: %#v", meta.Roots)
	}
	if len(meta.Skills) != 2 {
		t.Fatalf("expected 2 skills, got %#v", meta.Skills)
	}
	if meta.Skills[0].Name != "local-skill" || meta.Skills[0].Description != "Local skill desc" {
		t.Fatalf("unexpected first skill: %#v", meta.Skills[0])
	}
	if len(meta.Agents) != 1 || meta.Agents[0].Name != "local-agent" || meta.Agents[0].Description != "Local agent desc" {
		t.Fatalf("unexpected agents: %#v", meta.Agents)
	}
}

func TestBuildSessionBootstrapBuildsPromptAndMCPConfig(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	cwd := filepath.Join(t.TempDir(), "repo")
	tempDir := filepath.Join(t.TempDir(), "tmp")

	mustWrite := func(path, content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", path, err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}

	mustWrite(filepath.Join(home, ".pizzapi", "AGENTS.md"), "Global instructions")
	mustWrite(filepath.Join(cwd, "CLAUDE.md"), "Project instructions")
	mustWrite(filepath.Join(home, ".pizzapi", "config.json"), `{
  "mcpServers": {
    "global": {"command": "uvx", "args": ["gm"]},
    "shared": {"command": "global-cmd"}
  }
}`)
	mustWrite(filepath.Join(cwd, ".pizzapi", "config.json"), `{
  "mcpServers": {
    "shared": {"command": "project-cmd"},
    "remote": {"url": "https://example.com/mcp", "type": "http"}
  }
}`)

	bootstrap, err := buildSessionBootstrap(cwd, home, tempDir)
	if err != nil {
		t.Fatalf("buildSessionBootstrap: %v", err)
	}
	defer bootstrap.Cleanup()

	if !strings.Contains(bootstrap.SystemPrompt, "Project instructions") || !strings.Contains(bootstrap.SystemPrompt, "Global instructions") {
		t.Fatalf("system prompt missing instruction docs: %q", bootstrap.SystemPrompt)
	}
	if strings.Index(bootstrap.SystemPrompt, "Project instructions") > strings.Index(bootstrap.SystemPrompt, "Global instructions") {
		t.Fatalf("expected project instructions to come before global instructions: %q", bootstrap.SystemPrompt)
	}
	if bootstrap.MCPConfigPath == "" {
		t.Fatal("expected MCP config path to be created")
	}

	data, err := os.ReadFile(bootstrap.MCPConfigPath)
	if err != nil {
		t.Fatalf("read mcp config: %v", err)
	}
	var decoded struct {
		MCPServers map[string]map[string]any `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal mcp config: %v", err)
	}
	if decoded.MCPServers["shared"]["command"] != "project-cmd" {
		t.Fatalf("expected project override for shared server, got %#v", decoded.MCPServers["shared"])
	}
	if decoded.MCPServers["remote"]["type"] != "http" {
		t.Fatalf("expected streamable/http remote server, got %#v", decoded.MCPServers["remote"])
	}

	path := bootstrap.MCPConfigPath
	bootstrap.Cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected cleanup to remove temp config, stat err=%v", err)
	}
}
