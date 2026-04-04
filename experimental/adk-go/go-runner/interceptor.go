package main

import (
	"os"

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
// planMode is a closure that returns the session's current plan mode state. It is called
// on every tool invocation so that mid-session toggle_plan_mode changes take effect
// immediately without requiring a new interceptor to be constructed.
func NewGuardrailsInterceptor(sandboxCfg bootstrap.SandboxConfig, cwd, homeDir string, planMode func() bool) ToolCallInterceptor {
	baseCfg := mapSandboxConfig(sandboxCfg, cwd)
	return func(toolName string, args map[string]any) (bool, string) {
		env := guardrails.EvalEnv{
			CWD:     cwd,
			HomeDir: homeDir,
			Session: guardrails.SessionState{PlanMode: planMode()},
			Config:  baseCfg,
		}
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
//
// cwd is the session working directory. When AllowedPaths is set, cwd and
// /tmp are always appended to the resulting AllowWrite list so that user
// config additions never silently revoke the baseline write access the
// session needs to function.
func mapSandboxConfig(cfg bootstrap.SandboxConfig, cwd string) guardrails.SandboxConfig {
	mode := mapSandboxMode(cfg.Mode)

	var fs *guardrails.FilesystemConfig
	if len(cfg.AllowedPaths) > 0 || len(cfg.BlockedPaths) > 0 {
		// Always include the session CWD and /tmp as baseline write paths so
		// that user-specified AllowedPaths additions do not strip them.
		allowWrite := append([]string{}, cfg.AllowedPaths...)
		allowWrite = append(allowWrite, cwd, os.TempDir())
		fs = &guardrails.FilesystemConfig{
			AllowWrite: allowWrite,
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
//
// The content field may arrive as either []any (when items were decoded into an
// interface slice) or []map[string]any (when the JSON decoder infers a more
// specific type). Both shapes are handled; the typed slice is tried first.
func extractToolUseBlocks(ev map[string]any) []toolUseBlock {
	contentRaw, exists := ev["content"]
	if !exists || contentRaw == nil {
		return nil
	}

	// Normalise both content shapes into a flat []map[string]any for uniform processing.
	var items []map[string]any
	switch typed := contentRaw.(type) {
	case []map[string]any:
		// More-specific type produced by some JSON decoders — use directly.
		items = typed
	case []any:
		// Generic interface slice — extract the underlying map from each element.
		for _, item := range typed {
			if block, ok := item.(map[string]any); ok {
				items = append(items, block)
			}
		}
	default:
		return nil
	}

	var blocks []toolUseBlock
	for _, block := range items {
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
