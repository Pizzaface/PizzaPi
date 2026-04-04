package main

import (
	bootstrap "github.com/pizzaface/pizzapi/experimental/adk-go/go-runner/internal/bootstrap"
	"github.com/pizzaface/pizzapi/experimental/adk-go/runtime/guardrails"
)

// ToolCallInterceptor is a hook invoked before a native tool call is dispatched.
// It returns (allowed=true, reason="") to permit, or (allowed=false, reason="...") to deny.
// A nil interceptor means no interception — all calls pass through.
type ToolCallInterceptor func(toolName string, args map[string]any) (allowed bool, reason string)

// NewGuardrailsInterceptor builds a ToolCallInterceptor backed by the guardrails package.
// The interceptor evaluates each tool call against the sandbox policy derived from the
// PizzaPi config, the session CWD and home directory, and the current plan mode flag.
//
// The returned interceptor captures the environment at construction time. Plan mode
// changes during a session require constructing a new interceptor.
func NewGuardrailsInterceptor(sandboxCfg bootstrap.SandboxConfig, cwd, homeDir string, planMode bool) ToolCallInterceptor {
	env := guardrails.EvalEnv{
		CWD:     cwd,
		HomeDir: homeDir,
		Session: guardrails.SessionState{PlanMode: planMode},
		Config:  mapSandboxConfig(sandboxCfg),
	}
	return func(toolName string, args map[string]any) (bool, string) {
		decision := guardrails.EvaluateToolCall(guardrails.ToolCall{Name: toolName, Args: args}, env)
		return decision.Allowed, decision.Reason
	}
}

// mapSandboxConfig converts a bootstrap.SandboxConfig to a guardrails.SandboxConfig.
// The bootstrap and guardrails packages use different mode naming conventions and
// slightly different filesystem field semantics; this function bridges the gap.
//
// Bootstrap mode → guardrails mode:
//
//	"" / "off" / "none"           → ModeNone  (no enforcement)
//	"full" / "restricted"         → ModeFull  (strict network + filesystem)
//	anything else (e.g. "basic")  → ModeBasic (filesystem only by default)
func mapSandboxConfig(cfg bootstrap.SandboxConfig) guardrails.SandboxConfig {
	mode := mapSandboxMode(cfg.Mode)

	var fs *guardrails.FilesystemConfig
	if len(cfg.AllowedPaths) > 0 || len(cfg.BlockedPaths) > 0 {
		fs = &guardrails.FilesystemConfig{
			AllowWrite: cfg.AllowedPaths,
			DenyRead:   cfg.BlockedPaths,
			DenyWrite:  cfg.BlockedPaths,
		}
	}

	var net *guardrails.NetworkConfig
	if len(cfg.AllowedDomains) > 0 || len(cfg.BlockedDomains) > 0 {
		net = &guardrails.NetworkConfig{
			AllowedDomains: cfg.AllowedDomains,
			DeniedDomains:  cfg.BlockedDomains,
		}
	}

	return guardrails.SandboxConfig{
		Mode:       mode,
		Filesystem: fs,
		Network:    net,
	}
}

// mapSandboxMode maps PizzaPi config mode strings to guardrails.SandboxMode values.
func mapSandboxMode(mode string) guardrails.SandboxMode {
	switch mode {
	case "none", "off", "":
		return guardrails.ModeNone
	case "full", "restricted":
		return guardrails.ModeFull
	default:
		// "basic", "permissive", or any unrecognised value → basic enforcement
		return guardrails.ModeBasic
	}
}

// extractToolUseBlocks scans a relay event's content array for tool_use blocks
// and returns their names and args. It is used in runSession to inspect
// message_update events before forwarding them — the entry point for the future
// native tool execution interception path.
func extractToolUseBlocks(ev map[string]any) []toolUseBlock {
	content, ok := ev["content"].([]any)
	if !ok {
		return nil
	}
	var blocks []toolUseBlock
	for _, item := range content {
		block, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if blockType, _ := block["type"].(string); blockType != "tool_use" {
			continue
		}
		name, _ := block["name"].(string)
		if name == "" {
			continue
		}
		args, _ := block["input"].(map[string]any)
		blocks = append(blocks, toolUseBlock{Name: name, Args: args})
	}
	return blocks
}

// toolUseBlock holds the extracted name and args from a tool_use content block.
type toolUseBlock struct {
	Name string
	Args map[string]any
}
