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

// ---------------------------------------------------------------------------
// ParsePizzaPiConfig — malformed / edge-case inputs
// ---------------------------------------------------------------------------

func TestParsePizzaPiConfigInvalidTopLevelJSON(t *testing.T) {
	_, err := ParsePizzaPiConfig([]byte(`{not valid json`))
	if err == nil {
		t.Fatal("expected error for invalid JSON, got nil")
	}
}

func TestParsePizzaPiConfigEmptyMCPServers(t *testing.T) {
	cfg, err := ParsePizzaPiConfig([]byte(`{"mcpServers": {}}`))
	if err != nil {
		t.Fatalf("expected no error for empty mcpServers, got %v", err)
	}
	if len(cfg.Servers) != 0 {
		t.Errorf("expected 0 servers, got %d", len(cfg.Servers))
	}
}

func TestParsePizzaPiConfigNoMCPServersField(t *testing.T) {
	// Config with no mcpServers key at all — should return empty config.
	cfg, err := ParsePizzaPiConfig([]byte(`{"appendSystemPrompt": "hello"}`))
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(cfg.Servers) != 0 {
		t.Errorf("expected 0 servers, got %d", len(cfg.Servers))
	}
}

func TestParsePizzaPiConfigServerMissingCommandAndURL(t *testing.T) {
	_, err := ParsePizzaPiConfig([]byte(`{
		"mcpServers": {
			"broken": {"env": {"FOO": "bar"}}
		}
	}`))
	if err == nil {
		t.Fatal("expected error for server missing command and url, got nil")
	}
}

func TestParsePizzaPiConfigServerInvalidEntryJSON(t *testing.T) {
	// Server entry value is not an object — unmarshal should fail.
	_, err := ParsePizzaPiConfig([]byte(`{
		"mcpServers": {
			"bad": "not-an-object"
		}
	}`))
	if err == nil {
		t.Fatal("expected error for non-object server entry, got nil")
	}
}

func TestParsePizzaPiConfigNullServerEntry(t *testing.T) {
	// Null server entry: json.RawMessage will be `null`.
	// Unmarshalling null into rawServer gives an empty struct,
	// which fails the command/url check.
	_, err := ParsePizzaPiConfig([]byte(`{
		"mcpServers": {
			"nullsvc": null
		}
	}`))
	if err == nil {
		t.Fatal("expected error for null server entry, got nil")
	}
}

func TestParsePizzaPiConfigNullMCPServersField(t *testing.T) {
	// null mcpServers value — should parse without error and produce empty config.
	cfg, err := ParsePizzaPiConfig([]byte(`{"mcpServers": null}`))
	if err != nil {
		t.Fatalf("expected no error for null mcpServers, got %v", err)
	}
	if len(cfg.Servers) != 0 {
		t.Errorf("expected 0 servers, got %d", len(cfg.Servers))
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
