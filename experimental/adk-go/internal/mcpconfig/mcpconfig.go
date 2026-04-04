package mcpconfig

import (
	"encoding/json"
	"fmt"
)

// Transport identifies the normalized MCP transport PizzaPi config uses.
type Transport string

const (
	TransportStdio      Transport = "stdio"
	TransportSSE        Transport = "sse"
	TransportStreamable Transport = "streamable"
)

// Server is the normalized Go model for a single PizzaPi mcpServers entry.
type Server struct {
	Name      string
	Transport Transport
	Command   string
	Args      []string
	Env       map[string]string
	Cwd       string
	URL       string
	Headers   map[string]string
}

// Config is the normalized Go model for PizzaPi's mcpServers{} shape.
type Config struct {
	Servers map[string]Server
}

// ParsePizzaPiConfig parses the top-level PizzaPi config JSON and extracts the
// normalized mcpServers{} model.
func ParsePizzaPiConfig(data []byte) (Config, error) {
	var raw struct {
		MCPServers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return Config{}, err
	}

	cfg := Config{Servers: map[string]Server{}}
	for name, entry := range raw.MCPServers {
		server, err := parseServer(name, entry)
		if err != nil {
			return Config{}, err
		}
		cfg.Servers[name] = server
	}
	return cfg, nil
}

// Merge deep-merges two parsed configs by server name. Project entries overwrite
// global entries with the same name, matching PizzaPi's precedence behavior.
func Merge(global, project Config) Config {
	merged := Config{Servers: map[string]Server{}}
	for name, server := range global.Servers {
		merged.Servers[name] = cloneServer(server)
	}
	for name, server := range project.Servers {
		merged.Servers[name] = cloneServer(server)
	}
	return merged
}

// MarshalClaudeConfigJSON emits the Claude CLI --mcp-config JSON shape.
func (c Config) MarshalClaudeConfigJSON() ([]byte, error) {
	claude := struct {
		MCPServers map[string]any `json:"mcpServers"`
	}{MCPServers: map[string]any{}}

	for name, server := range c.Servers {
		switch server.Transport {
		case TransportStdio:
			entry := struct {
				Args    []string          `json:"args,omitempty"`
				Command string            `json:"command"`
				Cwd     string            `json:"cwd,omitempty"`
				Env     map[string]string `json:"env,omitempty"`
			}{
				Args:    cloneStringSlice(server.Args),
				Command: server.Command,
				Cwd:     server.Cwd,
				Env:     cloneStringMap(server.Env),
			}
			claude.MCPServers[name] = entry
		case TransportStreamable:
			entry := struct {
				Headers map[string]string `json:"headers,omitempty"`
				Type    string            `json:"type"`
				URL     string            `json:"url"`
			}{
				Headers: cloneStringMap(server.Headers),
				Type:    "http",
				URL:     server.URL,
			}
			claude.MCPServers[name] = entry
		case TransportSSE:
			entry := struct {
				Headers map[string]string `json:"headers,omitempty"`
				Type    string            `json:"type"`
				URL     string            `json:"url"`
			}{
				Headers: cloneStringMap(server.Headers),
				Type:    "sse",
				URL:     server.URL,
			}
			claude.MCPServers[name] = entry
		default:
			return nil, fmt.Errorf("server %q has unsupported transport %q", name, server.Transport)
		}
	}

	return json.MarshalIndent(claude, "", "  ")
}

type rawServer struct {
	Command   string            `json:"command"`
	Args      []string          `json:"args"`
	Env       map[string]string `json:"env"`
	Cwd       string            `json:"cwd"`
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	Transport string            `json:"transport"`
	Type      string            `json:"type"`
}

func parseServer(name string, data []byte) (Server, error) {
	var raw rawServer
	if err := json.Unmarshal(data, &raw); err != nil {
		return Server{}, fmt.Errorf("parse mcpServers.%s: %w", name, err)
	}

	if raw.Command != "" {
		return Server{
			Name:      name,
			Transport: TransportStdio,
			Command:   raw.Command,
			Args:      cloneStringSlice(raw.Args),
			Env:       cloneStringMap(raw.Env),
			Cwd:       raw.Cwd,
		}, nil
	}
	if raw.URL != "" {
		transport := normalizeRemoteTransport(raw.Transport, raw.Type)
		return Server{
			Name:      name,
			Transport: transport,
			URL:       raw.URL,
			Headers:   cloneStringMap(raw.Headers),
		}, nil
	}

	return Server{}, fmt.Errorf("parse mcpServers.%s: entry must contain either command or url", name)
}

func normalizeRemoteTransport(rawTransport, rawType string) Transport {
	switch rawTransport {
	case "streamable":
		return TransportStreamable
	case "sse", "http", "":
		// Fall through to type-based normalization below.
	default:
		return TransportSSE
	}

	switch rawType {
	case "http":
		return TransportStreamable
	case "sse", "":
		return TransportSSE
	default:
		return TransportSSE
	}
}

func cloneServer(server Server) Server {
	server.Args = cloneStringSlice(server.Args)
	server.Env = cloneStringMap(server.Env)
	server.Headers = cloneStringMap(server.Headers)
	return server
}

func cloneStringSlice(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	cloned := make([]string, len(values))
	copy(cloned, values)
	return cloned
}

func cloneStringMap(values map[string]string) map[string]string {
	if len(values) == 0 {
		return nil
	}
	cloned := make(map[string]string, len(values))
	for key, value := range values {
		cloned[key] = value
	}
	return cloned
}
