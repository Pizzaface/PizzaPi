package adk

import (
	"testing"
)

func TestAllTools_CreatesAllFour(t *testing.T) {
	tools, err := AllTools("/tmp/test")
	if err != nil {
		t.Fatalf("AllTools failed: %v", err)
	}
	if len(tools) != 4 {
		t.Fatalf("expected 4 tools, got %d", len(tools))
	}

	// Verify tool names
	expected := map[string]bool{
		"bash":  false,
		"read":  false,
		"write": false,
		"edit":  false,
	}
	for _, tool := range tools {
		name := tool.Name()
		if _, ok := expected[name]; !ok {
			t.Errorf("unexpected tool name %q", name)
		}
		expected[name] = true
	}
	for name, found := range expected {
		if !found {
			t.Errorf("missing expected tool %q", name)
		}
	}
}

func TestNewBashTool_Creates(t *testing.T) {
	tool, err := NewBashTool("/tmp")
	if err != nil {
		t.Fatalf("NewBashTool failed: %v", err)
	}
	if tool.Name() != "bash" {
		t.Errorf("expected name 'bash', got %q", tool.Name())
	}
}

func TestNewReadTool_Creates(t *testing.T) {
	tool, err := NewReadTool("/tmp")
	if err != nil {
		t.Fatalf("NewReadTool failed: %v", err)
	}
	if tool.Name() != "read" {
		t.Errorf("expected name 'read', got %q", tool.Name())
	}
}

func TestNewWriteTool_Creates(t *testing.T) {
	tool, err := NewWriteTool("/tmp")
	if err != nil {
		t.Fatalf("NewWriteTool failed: %v", err)
	}
	if tool.Name() != "write" {
		t.Errorf("expected name 'write', got %q", tool.Name())
	}
}

func TestNewEditTool_Creates(t *testing.T) {
	tool, err := NewEditTool("/tmp")
	if err != nil {
		t.Fatalf("NewEditTool failed: %v", err)
	}
	if tool.Name() != "edit" {
		t.Errorf("expected name 'edit', got %q", tool.Name())
	}
}

func TestResolvePath_Absolute(t *testing.T) {
	got := resolvePath("/usr/bin/ls", "/home/user")
	if got != "/usr/bin/ls" {
		t.Errorf("expected /usr/bin/ls, got %s", got)
	}
}

func TestResolvePath_Relative(t *testing.T) {
	got := resolvePath("foo/bar.go", "/home/user")
	if got != "/home/user/foo/bar.go" {
		t.Errorf("expected /home/user/foo/bar.go, got %s", got)
	}
}

func TestResolvePath_Tilde(t *testing.T) {
	got := resolvePath("~/Documents", "/home/user")
	if got != "~/Documents" {
		t.Errorf("expected ~/Documents (unchanged), got %s", got)
	}
}
