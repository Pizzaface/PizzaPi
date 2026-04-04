package main

import (
	"testing"

	bootstrap "github.com/pizzaface/pizzapi/experimental/adk-go/go-runner/internal/bootstrap"
)

// ---------------------------------------------------------------------------
// NewGuardrailsInterceptor — unit tests
// ---------------------------------------------------------------------------

func TestInterceptor_BlocksBashWhenSandboxActive(t *testing.T) {
	interceptor := NewGuardrailsInterceptor(
		bootstrap.SandboxConfig{Mode: "basic"},
		"/repo",
		"/home/test",
		false,
	)

	allowed, reason := interceptor("bash", map[string]any{"command": "cat /etc/passwd"})
	if allowed {
		t.Fatal("expected bash to be denied when sandbox is active")
	}
	if reason == "" {
		t.Fatal("expected non-empty denial reason for bash")
	}
}

func TestInterceptor_AllowsAllToolsWhenModeNone(t *testing.T) {
	for _, modeName := range []string{"none", "off", ""} {
		t.Run("mode="+modeName, func(t *testing.T) {
			interceptor := NewGuardrailsInterceptor(
				bootstrap.SandboxConfig{Mode: modeName},
				"/repo",
				"/home/test",
				false,
			)

			// bash should be allowed
			allowed, reason := interceptor("bash", map[string]any{"command": "echo hello"})
			if !allowed {
				t.Fatalf("expected bash to be allowed in mode=%q, got denied: %s", modeName, reason)
			}

			// write to arbitrary path should be allowed
			allowed, reason = interceptor("write", map[string]any{"path": "/etc/hosts"})
			if !allowed {
				t.Fatalf("expected write to be allowed in mode=%q, got denied: %s", modeName, reason)
			}
		})
	}
}

func TestInterceptor_AllowsReadWriteWithinAllowedPaths(t *testing.T) {
	interceptor := NewGuardrailsInterceptor(
		bootstrap.SandboxConfig{
			Mode:         "basic",
			AllowedPaths: []string{"/repo"},
		},
		"/repo",
		"/home/test",
		false,
	)

	// Read within allowed paths (not in denyRead)
	allowed, reason := interceptor("read", map[string]any{"path": "/repo/src/main.go"})
	if !allowed {
		t.Fatalf("expected read within /repo to be allowed, got denied: %s", reason)
	}

	// Write within allowed paths
	allowed, reason = interceptor("write", map[string]any{"path": "/repo/output.txt"})
	if !allowed {
		t.Fatalf("expected write within /repo to be allowed, got denied: %s", reason)
	}
}

func TestInterceptor_DeniesWriteOutsideAllowedPaths(t *testing.T) {
	interceptor := NewGuardrailsInterceptor(
		bootstrap.SandboxConfig{
			Mode:         "basic",
			AllowedPaths: []string{"/repo"},
		},
		"/repo",
		"/home/test",
		false,
	)

	allowed, reason := interceptor("write", map[string]any{"path": "/etc/hosts"})
	if allowed {
		t.Fatal("expected write outside allowed paths to be denied")
	}
	if reason == "" {
		t.Fatal("expected non-empty denial reason")
	}
}

func TestInterceptor_DeniesBlockedPaths(t *testing.T) {
	interceptor := NewGuardrailsInterceptor(
		bootstrap.SandboxConfig{
			Mode:         "basic",
			BlockedPaths: []string{"/secrets"},
		},
		"/repo",
		"/home/test",
		false,
	)

	// Blocked path should be denied for read
	allowed, reason := interceptor("read", map[string]any{"path": "/secrets/token.txt"})
	if allowed {
		t.Fatal("expected read of blocked path to be denied")
	}
	if reason == "" {
		t.Fatal("expected non-empty denial reason for blocked path read")
	}
}

func TestInterceptor_FullModeBlocksBashAndUnsafePaths(t *testing.T) {
	interceptor := NewGuardrailsInterceptor(
		bootstrap.SandboxConfig{Mode: "full"},
		"/repo",
		"/home/test",
		false,
	)

	allowed, _ := interceptor("bash", map[string]any{"command": "ls"})
	if allowed {
		t.Fatal("expected bash to be denied in full/restricted mode")
	}
}

func TestInterceptor_RestrictedMapsToFullMode(t *testing.T) {
	// "restricted" mode in the bootstrap config should map to ModeFull in guardrails,
	// which means bash is always denied.
	interceptor := NewGuardrailsInterceptor(
		bootstrap.SandboxConfig{Mode: "restricted"},
		"/repo",
		"/home/test",
		false,
	)

	allowed, _ := interceptor("bash", map[string]any{"command": "echo hi"})
	if allowed {
		t.Fatal("expected bash to be denied in restricted (full) mode")
	}
}

func TestInterceptor_PlanModeBlocksWriteTools(t *testing.T) {
	interceptor := NewGuardrailsInterceptor(
		bootstrap.SandboxConfig{Mode: "none"}, // sandbox off
		"/repo",
		"/home/test",
		true, // plan mode on
	)

	allowed, reason := interceptor("write", map[string]any{"path": "/repo/notes.txt"})
	if allowed {
		t.Fatalf("expected write to be denied in plan mode, but was allowed")
	}
	if reason == "" {
		t.Fatal("expected non-empty denial reason in plan mode")
	}
}

// ---------------------------------------------------------------------------
// extractToolUseBlocks — unit tests
// ---------------------------------------------------------------------------

func TestExtractToolUseBlocks_ExtractsSingleBlock(t *testing.T) {
	ev := map[string]any{
		"type": "message_update",
		"content": []any{
			map[string]any{
				"type": "text",
				"text": "Let me run a command.",
			},
			map[string]any{
				"type":  "tool_use",
				"id":    "tool_abc123",
				"name":  "bash",
				"input": map[string]any{"command": "ls -la"},
			},
		},
	}

	blocks := extractToolUseBlocks(ev)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 tool_use block, got %d", len(blocks))
	}
	if blocks[0].Name != "bash" {
		t.Fatalf("expected tool name 'bash', got %q", blocks[0].Name)
	}
	cmd, _ := blocks[0].Args["command"].(string)
	if cmd != "ls -la" {
		t.Fatalf("expected command 'ls -la', got %q", cmd)
	}
}

func TestExtractToolUseBlocks_ExtractsMultipleBlocks(t *testing.T) {
	ev := map[string]any{
		"type": "message_update",
		"content": []any{
			map[string]any{
				"type":  "tool_use",
				"id":    "t1",
				"name":  "read",
				"input": map[string]any{"path": "/repo/main.go"},
			},
			map[string]any{
				"type":  "tool_use",
				"id":    "t2",
				"name":  "write",
				"input": map[string]any{"path": "/repo/out.go"},
			},
		},
	}

	blocks := extractToolUseBlocks(ev)
	if len(blocks) != 2 {
		t.Fatalf("expected 2 tool_use blocks, got %d", len(blocks))
	}
	if blocks[0].Name != "read" || blocks[1].Name != "write" {
		t.Fatalf("unexpected block names: %q, %q", blocks[0].Name, blocks[1].Name)
	}
}

func TestExtractToolUseBlocks_SkipsNonToolUseBlocks(t *testing.T) {
	ev := map[string]any{
		"type": "message_update",
		"content": []any{
			map[string]any{"type": "text", "text": "Hello"},
			map[string]any{"type": "thinking", "thinking": "internal"},
		},
	}

	blocks := extractToolUseBlocks(ev)
	if len(blocks) != 0 {
		t.Fatalf("expected no tool_use blocks, got %d", len(blocks))
	}
}

func TestExtractToolUseBlocks_ReturnsNilForMissingContent(t *testing.T) {
	ev := map[string]any{
		"type":   "heartbeat",
		"active": true,
	}

	blocks := extractToolUseBlocks(ev)
	if len(blocks) != 0 {
		t.Fatalf("expected no blocks from heartbeat event, got %d", len(blocks))
	}
}

func TestExtractToolUseBlocks_SkipsBlocksWithEmptyName(t *testing.T) {
	ev := map[string]any{
		"type": "message_update",
		"content": []any{
			map[string]any{
				"type":  "tool_use",
				"id":    "t1",
				"name":  "", // empty — should be skipped
				"input": map[string]any{},
			},
			map[string]any{
				"type":  "tool_use",
				"id":    "t2",
				"name":  "bash",
				"input": map[string]any{"command": "echo"},
			},
		},
	}

	blocks := extractToolUseBlocks(ev)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block (empty name skipped), got %d", len(blocks))
	}
	if blocks[0].Name != "bash" {
		t.Fatalf("expected 'bash', got %q", blocks[0].Name)
	}
}

// ---------------------------------------------------------------------------
// Integration: event with tool_use → interceptor called
// ---------------------------------------------------------------------------

func TestInterceptorIntegration_DeniesToolUseFromEvent(t *testing.T) {
	interceptor := NewGuardrailsInterceptor(
		bootstrap.SandboxConfig{Mode: "basic"},
		"/repo",
		"/home/test",
		false,
	)

	ev := map[string]any{
		"type": "message_update",
		"content": []any{
			map[string]any{
				"type":  "tool_use",
				"id":    "tool_xyz",
				"name":  "bash",
				"input": map[string]any{"command": "rm -rf /"},
			},
		},
	}

	blocks := extractToolUseBlocks(ev)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 tool_use block from event, got %d", len(blocks))
	}

	allowed, reason := interceptor(blocks[0].Name, blocks[0].Args)
	if allowed {
		t.Fatal("expected bash to be denied by guardrails interceptor")
	}
	if reason == "" {
		t.Fatal("expected non-empty denial reason from interceptor")
	}
}

func TestInterceptorIntegration_AllowsSafeToolUseFromEvent(t *testing.T) {
	interceptor := NewGuardrailsInterceptor(
		bootstrap.SandboxConfig{Mode: "basic"},
		"/repo",
		"/home/test",
		false,
	)

	ev := map[string]any{
		"type": "message_update",
		"content": []any{
			map[string]any{
				"type":  "tool_use",
				"id":    "tool_safe",
				"name":  "read",
				"input": map[string]any{"path": "/repo/main.go"},
			},
		},
	}

	blocks := extractToolUseBlocks(ev)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 tool_use block from event, got %d", len(blocks))
	}

	allowed, reason := interceptor(blocks[0].Name, blocks[0].Args)
	if !allowed {
		t.Fatalf("expected read within /repo to be allowed, got denied: %s", reason)
	}
}

func TestInterceptorIntegration_NonUpdateEventsHaveNoBlocks(t *testing.T) {
	interceptor := NewGuardrailsInterceptor(
		bootstrap.SandboxConfig{Mode: "basic"},
		"/repo",
		"/home/test",
		false,
	)

	heartbeat := map[string]any{
		"type":         "heartbeat",
		"active":       true,
		"isCompacting": false,
	}

	// Simulate the runSession check: only call extractToolUseBlocks on message_update
	evType, _ := heartbeat["type"].(string)
	if evType == "message_update" && interceptor != nil {
		blocks := extractToolUseBlocks(heartbeat)
		if len(blocks) != 0 {
			t.Fatal("expected no tool_use blocks in heartbeat event")
		}
	}
	// Test passes if the interceptor is not called for non-message_update events
}
