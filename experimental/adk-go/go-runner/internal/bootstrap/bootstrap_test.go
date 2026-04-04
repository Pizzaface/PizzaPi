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
