package registration

import (
	"os"
	"path/filepath"
	"testing"
)

// ---------------------------------------------------------------------------
// frontmatterDescription
// ---------------------------------------------------------------------------

func TestFrontmatterDescriptionPlain(t *testing.T) {
	text := "---\ndescription: Use this to do things\n---\n# Title\n"
	got := frontmatterDescription(text)
	want := "Use this to do things"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestFrontmatterDescriptionDoubleQuoted(t *testing.T) {
	text := "---\ndescription: \"Quoted description\"\n---\n"
	got := frontmatterDescription(text)
	want := "Quoted description"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestFrontmatterDescriptionDoubleQuotedEscape(t *testing.T) {
	text := `---` + "\n" + `description: "She said \"hello\""` + "\n" + `---` + "\n"
	got := frontmatterDescription(text)
	want := `She said "hello"`
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestFrontmatterDescriptionSingleQuoted(t *testing.T) {
	text := "---\ndescription: 'It''s a test'\n---\n"
	got := frontmatterDescription(text)
	want := "It's a test"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestFrontmatterDescriptionBlockLiteral(t *testing.T) {
	text := "---\ndescription: |\n  First line\n  Second line\n---\n"
	got := frontmatterDescription(text)
	want := "First line Second line"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestFrontmatterDescriptionBlockFolded(t *testing.T) {
	text := "---\ndescription: >\n  Folded line one\n  Folded line two\n---\n"
	got := frontmatterDescription(text)
	want := "Folded line one Folded line two"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestFrontmatterDescriptionBlockLiteralChompStrip(t *testing.T) {
	text := "---\ndescription: |-\n  Only line\n---\n"
	got := frontmatterDescription(text)
	want := "Only line"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestFrontmatterDescriptionCaseInsensitiveKey(t *testing.T) {
	text := "---\nDescription: Mixed Case Key\n---\n"
	got := frontmatterDescription(text)
	want := "Mixed Case Key"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestFrontmatterDescriptionInlineComment(t *testing.T) {
	text := "---\ndescription: plain value # ignore this\n---\n"
	got := frontmatterDescription(text)
	want := "plain value"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestFrontmatterDescriptionNoFrontmatter(t *testing.T) {
	text := "# Just a markdown file\nNo frontmatter here.\n"
	got := frontmatterDescription(text)
	if got != "" {
		t.Fatalf("expected empty string, got %q", got)
	}
}

func TestFrontmatterDescriptionMissingClosingDelimiter(t *testing.T) {
	text := "---\ndescription: open block\nno closing delimiter\n"
	got := frontmatterDescription(text)
	if got != "" {
		t.Fatalf("expected empty string for unclosed frontmatter, got %q", got)
	}
}

func TestFrontmatterDescriptionNoDescriptionKey(t *testing.T) {
	text := "---\nname: my-agent\ntopics:\n  - testing\n---\n"
	got := frontmatterDescription(text)
	if got != "" {
		t.Fatalf("expected empty string when no description key, got %q", got)
	}
}

func TestFrontmatterDescriptionMultipleKeys(t *testing.T) {
	text := "---\nname: agent\ndescription: Found it\nauthor: somebody\n---\n"
	got := frontmatterDescription(text)
	want := "Found it"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestFrontmatterDescriptionEmptyValue(t *testing.T) {
	text := "---\ndescription:\nname: agent\n---\n"
	got := frontmatterDescription(text)
	// Empty value is valid — no fallback triggered from within frontmatterDescription
	if got != "" {
		t.Fatalf("expected empty string for empty description value, got %q", got)
	}
}

func TestFrontmatterDescriptionDotDotDotDelimiter(t *testing.T) {
	text := "---\ndescription: dot delimiter\n...\n"
	got := frontmatterDescription(text)
	want := "dot delimiter"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// ---------------------------------------------------------------------------
// resourceDescription (integration with frontmatterDescription + fallback)
// ---------------------------------------------------------------------------

func TestResourceDescriptionFallbackToFirstLine(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.md")
	if err := os.WriteFile(path, []byte("# My Agent\nThis is the first body line.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := resourceDescription(path, "fallback")
	want := "This is the first body line."
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestResourceDescriptionFallbackOnMissingFile(t *testing.T) {
	got := resourceDescription("/no/such/file.md", "my-fallback")
	if got != "my-fallback" {
		t.Fatalf("expected fallback name, got %q", got)
	}
}

func TestResourceDescriptionPrefersFrontmatter(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.md")
	content := "---\ndescription: Frontmatter wins\n---\n# Title\nBody line.\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	got := resourceDescription(path, "fallback")
	want := "Frontmatter wins"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// ---------------------------------------------------------------------------
// ResolveAgent
// ---------------------------------------------------------------------------

func writeAgentFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := filepath.Join(dir, name+".md")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestResolveAgentFound(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()
	agentDir := filepath.Join(home, ".pizzapi", "agents")
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		t.Fatal(err)
	}
	wantContent := "# My Agent\nDoes stuff.\n"
	writeAgentFile(t, agentDir, "my-agent", wantContent)

	content, ok, err := ResolveAgent("my-agent", cwd, home)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Fatal("expected agent to be found")
	}
	if content != wantContent {
		t.Fatalf("got %q, want %q", content, wantContent)
	}
}

func TestResolveAgentNotFound(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()

	content, ok, err := ResolveAgent("nonexistent", cwd, home)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("expected agent not to be found")
	}
	if content != "" {
		t.Fatalf("expected empty content, got %q", content)
	}
}

func TestResolveAgentProjectOverridesGlobal(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()

	globalDir := filepath.Join(home, ".pizzapi", "agents")
	projectDir := filepath.Join(cwd, ".pizzapi", "agents")
	if err := os.MkdirAll(globalDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}

	writeAgentFile(t, globalDir, "shared", "# Global version\n")
	writeAgentFile(t, projectDir, "shared", "# Project version\n")

	content, ok, err := ResolveAgent("shared", cwd, home)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Fatal("expected agent to be found")
	}
	// Project takes precedence
	if content != "# Project version\n" {
		t.Fatalf("expected project version, got %q", content)
	}
}

func TestResolveAgentEmptyDirectories(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()
	// No agents directories exist at all — should return not-found, no error.
	_, ok, err := ResolveAgent("anything", cwd, home)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("expected not found")
	}
}

// ---------------------------------------------------------------------------
// Discover (integration)
// ---------------------------------------------------------------------------

func TestDiscoverIncludesDescriptions(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()
	agentDir := filepath.Join(home, ".pizzapi", "agents")
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		t.Fatal(err)
	}

	content := "---\ndescription: Test agent for testing\n---\n# Agent\n"
	writeAgentFile(t, agentDir, "test-agent", content)

	meta, err := Discover(cwd, home)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(meta.Agents) != 1 {
		t.Fatalf("expected 1 agent, got %d", len(meta.Agents))
	}
	if meta.Agents[0].Description != "Test agent for testing" {
		t.Fatalf("unexpected description: %q", meta.Agents[0].Description)
	}
	if meta.Roots[0] != cwd {
		t.Fatalf("expected cwd in roots, got %v", meta.Roots)
	}
}
