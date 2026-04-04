package bootstrap

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

// ---------------------------------------------------------------------------
// LoadConfig — missing files
// ---------------------------------------------------------------------------

func TestLoadConfigBothMissing(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()

	cfg, err := LoadConfig(cwd, home)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.AllowProjectHooks {
		t.Error("expected AllowProjectHooks=false when no config exists")
	}
	if len(cfg.Hooks) != 0 {
		t.Errorf("expected no hooks, got %v", cfg.Hooks)
	}
	if cfg.AppendSystemPrompt != "" {
		t.Errorf("expected empty AppendSystemPrompt, got %q", cfg.AppendSystemPrompt)
	}
}

func TestLoadConfigGlobalOnlyMissing(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()

	// Write a project config — it should be ignored gracefully when global is absent.
	projectCfg := map[string]any{
		"appendSystemPrompt": "project prompt",
	}
	writeJSON(t, filepath.Join(cwd, ".pizzapi", "config.json"), projectCfg)

	cfg, err := LoadConfig(cwd, home)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Project prompt is loaded even without a global config.
	// AllowProjectHooks defaults false so project hooks are not merged,
	// but AppendSystemPrompt from project is always loaded.
	if cfg.AppendSystemPrompt != "project prompt" {
		t.Errorf("expected project prompt, got %q", cfg.AppendSystemPrompt)
	}
}

func TestLoadConfigProjectMissing(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()

	globalCfg := map[string]any{
		"appendSystemPrompt": "global prompt",
	}
	writeJSON(t, filepath.Join(home, ".pizzapi", "config.json"), globalCfg)

	cfg, err := LoadConfig(cwd, home)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.AppendSystemPrompt != "global prompt" {
		t.Errorf("expected %q, got %q", "global prompt", cfg.AppendSystemPrompt)
	}
}

// ---------------------------------------------------------------------------
// LoadConfig — sandbox
// ---------------------------------------------------------------------------

func TestLoadConfigSandboxFromGlobalOnly(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()

	globalCfg := map[string]any{
		"sandbox": map[string]any{
			"mode":           "restricted",
			"allowedPaths":   []string{"/tmp"},
			"blockedDomains": []string{"evil.com"},
		},
	}
	writeJSON(t, filepath.Join(home, ".pizzapi", "config.json"), globalCfg)

	// Project config tries to override sandbox — should be ignored.
	projectCfg := map[string]any{
		"sandbox": map[string]any{
			"mode": "off",
		},
	}
	writeJSON(t, filepath.Join(cwd, ".pizzapi", "config.json"), projectCfg)

	cfg, err := LoadConfig(cwd, home)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Sandbox.Mode != "restricted" {
		t.Errorf("expected sandbox mode=restricted, got %q", cfg.Sandbox.Mode)
	}
	if len(cfg.Sandbox.AllowedPaths) != 1 || cfg.Sandbox.AllowedPaths[0] != "/tmp" {
		t.Errorf("unexpected AllowedPaths: %v", cfg.Sandbox.AllowedPaths)
	}
	if len(cfg.Sandbox.BlockedDomains) != 1 || cfg.Sandbox.BlockedDomains[0] != "evil.com" {
		t.Errorf("unexpected BlockedDomains: %v", cfg.Sandbox.BlockedDomains)
	}
}

// ---------------------------------------------------------------------------
// LoadConfig — hooks
// ---------------------------------------------------------------------------

func TestLoadConfigHooksGlobalOnly(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()

	globalCfg := map[string]any{
		"hooks": map[string]any{
			"PreToolUse": []map[string]any{
				{
					"matcher": "Bash",
					"hooks": []map[string]any{
						{"type": "command", "command": "echo pre"},
					},
				},
			},
		},
	}
	writeJSON(t, filepath.Join(home, ".pizzapi", "config.json"), globalCfg)

	cfg, err := LoadConfig(cwd, home)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	entries, ok := cfg.Hooks["PreToolUse"]
	if !ok {
		t.Fatal("expected PreToolUse hooks")
	}
	if len(entries) != 1 || entries[0].Matcher != "Bash" {
		t.Errorf("unexpected hook entries: %v", entries)
	}
}

func TestLoadConfigProjectHooksIgnoredWhenNotAllowed(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()

	globalCfg := map[string]any{
		"allowProjectHooks": false,
		"hooks": map[string]any{
			"PreToolUse": []map[string]any{
				{"matcher": "*", "hooks": []map[string]any{{"type": "command", "command": "global-hook"}}},
			},
		},
	}
	writeJSON(t, filepath.Join(home, ".pizzapi", "config.json"), globalCfg)

	projectCfg := map[string]any{
		"hooks": map[string]any{
			"PreToolUse": []map[string]any{
				{"matcher": "Bash", "hooks": []map[string]any{{"type": "command", "command": "project-hook"}}},
			},
		},
	}
	writeJSON(t, filepath.Join(cwd, ".pizzapi", "config.json"), projectCfg)

	cfg, err := LoadConfig(cwd, home)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	entries := cfg.Hooks["PreToolUse"]
	if len(entries) != 1 {
		t.Fatalf("expected 1 hook (global only), got %d", len(entries))
	}
	if entries[0].Hooks[0].Command != "global-hook" {
		t.Errorf("expected global-hook command, got %q", entries[0].Hooks[0].Command)
	}
}

func TestLoadConfigProjectHooksMergedWhenAllowed(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()

	globalCfg := map[string]any{
		"allowProjectHooks": true,
		"hooks": map[string]any{
			"PreToolUse": []map[string]any{
				{"matcher": "*", "hooks": []map[string]any{{"type": "command", "command": "global-hook"}}},
			},
		},
	}
	writeJSON(t, filepath.Join(home, ".pizzapi", "config.json"), globalCfg)

	projectCfg := map[string]any{
		"hooks": map[string]any{
			"PreToolUse": []map[string]any{
				{"matcher": "Bash", "hooks": []map[string]any{{"type": "command", "command": "project-hook"}}},
			},
		},
	}
	writeJSON(t, filepath.Join(cwd, ".pizzapi", "config.json"), projectCfg)

	cfg, err := LoadConfig(cwd, home)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !cfg.AllowProjectHooks {
		t.Error("expected AllowProjectHooks=true")
	}
	entries := cfg.Hooks["PreToolUse"]
	if len(entries) != 2 {
		t.Fatalf("expected 2 hooks (global + project), got %d", len(entries))
	}
	// Global hooks come first.
	if entries[0].Hooks[0].Command != "global-hook" {
		t.Errorf("expected global hook first, got %q", entries[0].Hooks[0].Command)
	}
	if entries[1].Hooks[0].Command != "project-hook" {
		t.Errorf("expected project hook second, got %q", entries[1].Hooks[0].Command)
	}
}

func TestLoadConfigDistinctHookTypes(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()

	globalCfg := map[string]any{
		"allowProjectHooks": true,
		"hooks": map[string]any{
			"PreToolUse":  []map[string]any{{"matcher": "*", "hooks": []map[string]any{{"type": "command", "command": "pre"}}}},
			"PostToolUse": []map[string]any{{"matcher": "*", "hooks": []map[string]any{{"type": "command", "command": "post"}}}},
		},
	}
	writeJSON(t, filepath.Join(home, ".pizzapi", "config.json"), globalCfg)

	cfg, err := LoadConfig(cwd, home)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := cfg.Hooks["PreToolUse"]; !ok {
		t.Error("expected PreToolUse hooks")
	}
	if _, ok := cfg.Hooks["PostToolUse"]; !ok {
		t.Error("expected PostToolUse hooks")
	}
}

// ---------------------------------------------------------------------------
// LoadConfig — AppendSystemPrompt merging
// ---------------------------------------------------------------------------

func TestLoadConfigSystemPromptMerged(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()

	globalCfg := map[string]any{"appendSystemPrompt": "global extra"}
	projectCfg := map[string]any{"appendSystemPrompt": "project extra"}

	writeJSON(t, filepath.Join(home, ".pizzapi", "config.json"), globalCfg)
	writeJSON(t, filepath.Join(cwd, ".pizzapi", "config.json"), projectCfg)

	cfg, err := LoadConfig(cwd, home)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := "global extra\n\nproject extra"
	if cfg.AppendSystemPrompt != want {
		t.Errorf("got %q, want %q", cfg.AppendSystemPrompt, want)
	}
}

func TestLoadConfigSystemPromptGlobalOnly(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()

	globalCfg := map[string]any{"appendSystemPrompt": "only global"}
	writeJSON(t, filepath.Join(home, ".pizzapi", "config.json"), globalCfg)

	cfg, err := LoadConfig(cwd, home)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.AppendSystemPrompt != "only global" {
		t.Errorf("got %q", cfg.AppendSystemPrompt)
	}
}

// ---------------------------------------------------------------------------
// LoadConfig — malformed JSON
// ---------------------------------------------------------------------------

func TestLoadConfigMalformedGlobal(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()

	badPath := filepath.Join(home, ".pizzapi", "config.json")
	if err := os.MkdirAll(filepath.Dir(badPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(badPath, []byte("{not valid json"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := LoadConfig(cwd, home)
	if err == nil {
		t.Fatal("expected error for malformed JSON")
	}
}

// ---------------------------------------------------------------------------
// Build — MCP config temp file creation
// ---------------------------------------------------------------------------

func TestBuildWithStdioMCPServerCreatesTempFile(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()
	tmp := t.TempDir()

	// Write a global config with one stdio MCP server.
	globalCfg := map[string]any{
		"mcpServers": map[string]any{
			"godmother": map[string]any{
				"command": "godmother",
				"args":    []string{"serve"},
				"env":     map[string]string{"API_KEY": "secret"},
				"cwd":     "/repo",
			},
		},
	}
	writeJSON(t, filepath.Join(home, ".pizzapi", "config.json"), globalCfg)

	session, err := Build(cwd, home, tmp)
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	defer session.Cleanup()

	if session.MCPConfigPath == "" {
		t.Fatal("expected MCPConfigPath to be set, got empty string")
	}

	// Verify the temp file exists and parses correctly.
	data, err := os.ReadFile(session.MCPConfigPath)
	if err != nil {
		t.Fatalf("ReadFile(%q): %v", session.MCPConfigPath, err)
	}

	var out struct {
		MCPServers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("unmarshal temp file: %v", err)
	}
	if len(out.MCPServers) != 1 {
		t.Fatalf("expected 1 server, got %d", len(out.MCPServers))
	}
	raw, ok := out.MCPServers["godmother"]
	if !ok {
		t.Fatal("expected 'godmother' entry in mcpServers")
	}

	// Claude CLI stdio shape: command + args (no url/type).
	var entry struct {
		Command string            `json:"command"`
		Args    []string          `json:"args"`
		Cwd     string            `json:"cwd"`
		Env     map[string]string `json:"env"`
		URL     string            `json:"url"`
		Type    string            `json:"type"`
	}
	if err := json.Unmarshal(raw, &entry); err != nil {
		t.Fatalf("unmarshal server entry: %v", err)
	}
	if entry.Command != "godmother" {
		t.Errorf("command = %q, want %q", entry.Command, "godmother")
	}
	if len(entry.Args) != 1 || entry.Args[0] != "serve" {
		t.Errorf("args = %v, want [serve]", entry.Args)
	}
	if entry.Cwd != "/repo" {
		t.Errorf("cwd = %q, want /repo", entry.Cwd)
	}
	if entry.Env["API_KEY"] != "secret" {
		t.Errorf("env.API_KEY = %q, want secret", entry.Env["API_KEY"])
	}
	// Stdio entries must NOT have url or type.
	if entry.URL != "" {
		t.Errorf("stdio entry should not have url, got %q", entry.URL)
	}
	if entry.Type != "" {
		t.Errorf("stdio entry should not have type, got %q", entry.Type)
	}
}

func TestBuildWithStreamableMCPServerCreatesTempFile(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()
	tmp := t.TempDir()

	globalCfg := map[string]any{
		"mcpServers": map[string]any{
			"github": map[string]any{
				"type":    "http",
				"url":     "https://api.githubcopilot.com/mcp/",
				"headers": map[string]string{"Authorization": "Bearer token"},
			},
		},
	}
	writeJSON(t, filepath.Join(home, ".pizzapi", "config.json"), globalCfg)

	session, err := Build(cwd, home, tmp)
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	defer session.Cleanup()

	if session.MCPConfigPath == "" {
		t.Fatal("expected MCPConfigPath to be set")
	}

	data, err := os.ReadFile(session.MCPConfigPath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}

	var out struct {
		MCPServers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	raw, ok := out.MCPServers["github"]
	if !ok {
		t.Fatal("expected 'github' entry in mcpServers")
	}

	// Claude CLI streamable shape: url + type="http" (no command).
	var entry struct {
		URL     string            `json:"url"`
		Type    string            `json:"type"`
		Headers map[string]string `json:"headers"`
		Command string            `json:"command"`
	}
	if err := json.Unmarshal(raw, &entry); err != nil {
		t.Fatalf("unmarshal server entry: %v", err)
	}
	if entry.URL != "https://api.githubcopilot.com/mcp/" {
		t.Errorf("url = %q, want https://api.githubcopilot.com/mcp/", entry.URL)
	}
	if entry.Type != "http" {
		t.Errorf("type = %q, want http", entry.Type)
	}
	if entry.Headers["Authorization"] != "Bearer token" {
		t.Errorf("headers.Authorization = %q, want 'Bearer token'", entry.Headers["Authorization"])
	}
	if entry.Command != "" {
		t.Errorf("streamable entry should not have command, got %q", entry.Command)
	}
}

// ---------------------------------------------------------------------------
// Build — Cleanup removes temp file
// ---------------------------------------------------------------------------

func TestBuildCleanupRemovesTempFile(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()
	tmp := t.TempDir()

	globalCfg := map[string]any{
		"mcpServers": map[string]any{
			"svc": map[string]any{"command": "svc"},
		},
	}
	writeJSON(t, filepath.Join(home, ".pizzapi", "config.json"), globalCfg)

	session, err := Build(cwd, home, tmp)
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}

	path := session.MCPConfigPath
	if path == "" {
		t.Fatal("expected MCPConfigPath to be set")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("temp file should exist before Cleanup: %v", err)
	}

	session.Cleanup()

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("expected temp file to be removed after Cleanup, got err=%v", err)
	}
}

func TestBuildCleanupTwiceDoesNotPanic(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()
	tmp := t.TempDir()

	globalCfg := map[string]any{
		"mcpServers": map[string]any{
			"svc": map[string]any{"command": "svc"},
		},
	}
	writeJSON(t, filepath.Join(home, ".pizzapi", "config.json"), globalCfg)

	session, err := Build(cwd, home, tmp)
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}

	// Should not panic even when called twice.
	session.Cleanup()
	session.Cleanup()
}

// ---------------------------------------------------------------------------
// Build — empty mcpServers produces no temp file
// ---------------------------------------------------------------------------

func TestBuildEmptyMCPServersNoTempFile(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()
	tmp := t.TempDir()

	// Config with empty mcpServers map.
	globalCfg := map[string]any{
		"mcpServers": map[string]any{},
	}
	writeJSON(t, filepath.Join(home, ".pizzapi", "config.json"), globalCfg)

	session, err := Build(cwd, home, tmp)
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}

	if session.MCPConfigPath != "" {
		t.Errorf("expected no MCPConfigPath for empty mcpServers, got %q", session.MCPConfigPath)
	}

	// tempDir should be empty — no file was created.
	entries, err := os.ReadDir(tmp)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("expected no temp files for empty mcpServers, found %d", len(entries))
	}

	// Cleanup should be callable without panic even with no file.
	session.Cleanup()
}

func TestBuildNoConfigNoTempFile(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()
	tmp := t.TempDir()

	// No config files at all.
	session, err := Build(cwd, home, tmp)
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}

	if session.MCPConfigPath != "" {
		t.Errorf("expected no MCPConfigPath when no config exists, got %q", session.MCPConfigPath)
	}
	session.Cleanup()
}
