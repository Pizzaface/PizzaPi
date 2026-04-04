package mcpconfig

import (
	"testing"
)

func TestParsePizzaPiConfigParsesStdioAndStreamableServers(t *testing.T) {
	cfg, err := ParsePizzaPiConfig([]byte(`{
		"mcpServers": {
			"godmother": {
				"command": "godmother",
				"args": ["serve"],
				"env": {"API_KEY": "secret"},
				"cwd": "/repo"
			},
			"github": {
				"type": "http",
				"url": "https://api.githubcopilot.com/mcp/",
				"headers": {"Authorization": "Bearer token"}
			},
			"remote": {
				"transport": "streamable",
				"url": "https://example.com/mcp",
				"headers": {"X-Test": "1"}
			}
		}
	}`))
	if err != nil {
		t.Fatalf("ParsePizzaPiConfig() error = %v", err)
	}

	godmother, ok := cfg.Servers["godmother"]
	if !ok {
		t.Fatalf("missing godmother server")
	}
	if godmother.Transport != TransportStdio {
		t.Fatalf("godmother transport = %q, want %q", godmother.Transport, TransportStdio)
	}
	if godmother.Command != "godmother" {
		t.Fatalf("godmother command = %q", godmother.Command)
	}
	if len(godmother.Args) != 1 || godmother.Args[0] != "serve" {
		t.Fatalf("godmother args = %#v", godmother.Args)
	}
	if godmother.Env["API_KEY"] != "secret" {
		t.Fatalf("godmother env = %#v", godmother.Env)
	}
	if godmother.Cwd != "/repo" {
		t.Fatalf("godmother cwd = %q", godmother.Cwd)
	}

	github, ok := cfg.Servers["github"]
	if !ok {
		t.Fatalf("missing github server")
	}
	if github.Transport != TransportStreamable {
		t.Fatalf("github transport = %q, want %q", github.Transport, TransportStreamable)
	}
	if github.URL != "https://api.githubcopilot.com/mcp/" {
		t.Fatalf("github url = %q", github.URL)
	}
	if github.Headers["Authorization"] != "Bearer token" {
		t.Fatalf("github headers = %#v", github.Headers)
	}

	remote, ok := cfg.Servers["remote"]
	if !ok {
		t.Fatalf("missing remote server")
	}
	if remote.Transport != TransportStreamable {
		t.Fatalf("remote transport = %q, want %q", remote.Transport, TransportStreamable)
	}
	if remote.Headers["X-Test"] != "1" {
		t.Fatalf("remote headers = %#v", remote.Headers)
	}
}

func TestMergeProjectPrecedencePreservesGlobalOnlyServers(t *testing.T) {
	global, err := ParsePizzaPiConfig([]byte(`{
		"mcpServers": {
			"godmother": {"command": "godmother", "args": ["serve"]},
			"shared": {"command": "global-version"}
		}
	}`))
	if err != nil {
		t.Fatalf("parse global: %v", err)
	}
	project, err := ParsePizzaPiConfig([]byte(`{
		"mcpServers": {
			"playwright": {"command": "npx", "args": ["@playwright/mcp"]},
			"shared": {"type": "http", "url": "https://project.example/mcp"}
		}
	}`))
	if err != nil {
		t.Fatalf("parse project: %v", err)
	}

	merged := Merge(global, project)
	if len(merged.Servers) != 3 {
		t.Fatalf("len(merged.Servers) = %d, want 3", len(merged.Servers))
	}
	if merged.Servers["godmother"].Command != "godmother" {
		t.Fatalf("global-only server was not preserved: %#v", merged.Servers["godmother"])
	}
	if merged.Servers["playwright"].Command != "npx" {
		t.Fatalf("project-only server missing: %#v", merged.Servers["playwright"])
	}
	if merged.Servers["shared"].Transport != TransportStreamable {
		t.Fatalf("shared transport = %q, want %q", merged.Servers["shared"].Transport, TransportStreamable)
	}
	if merged.Servers["shared"].URL != "https://project.example/mcp" {
		t.Fatalf("project override did not win: %#v", merged.Servers["shared"])
	}
}

func TestMarshalClaudeConfigJSONUsesStableOrderingAndClaudeShape(t *testing.T) {
	cfg := Config{Servers: map[string]Server{
		"remote": {
			Name:      "remote",
			Transport: TransportStreamable,
			URL:       "https://example.com/mcp",
			Headers: map[string]string{
				"X-Trace":       "1",
				"Authorization": "Bearer token",
			},
		},
		"godmother": {
			Name:      "godmother",
			Transport: TransportStdio,
			Command:   "godmother",
			Args:      []string{"serve"},
			Env: map[string]string{
				"B": "2",
				"A": "1",
			},
			Cwd: "/repo",
		},
	}}

	got, err := cfg.MarshalClaudeConfigJSON()
	if err != nil {
		t.Fatalf("MarshalClaudeConfigJSON() error = %v", err)
	}
	gotAgain, err := cfg.MarshalClaudeConfigJSON()
	if err != nil {
		t.Fatalf("MarshalClaudeConfigJSON() second error = %v", err)
	}
	if string(got) != string(gotAgain) {
		t.Fatalf("MarshalClaudeConfigJSON() was not stable across calls\nfirst:\n%s\nsecond:\n%s", got, gotAgain)
	}

	want := `{
  "mcpServers": {
    "godmother": {
      "args": [
        "serve"
      ],
      "command": "godmother",
      "cwd": "/repo",
      "env": {
        "A": "1",
        "B": "2"
      }
    },
    "remote": {
      "headers": {
        "Authorization": "Bearer token",
        "X-Trace": "1"
      },
      "type": "http",
      "url": "https://example.com/mcp"
    }
  }
}`
	if string(got) != want {
		t.Fatalf("MarshalClaudeConfigJSON() mismatch\nwant:\n%s\n\ngot:\n%s", want, got)
	}
}
