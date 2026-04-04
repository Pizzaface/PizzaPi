package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// writeTemp creates a temporary file containing content and returns its path.
func writeTemp(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "test.txt")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("setup: write temp file: %v", err)
	}
	return path
}

// readFile reads the full content of a file, failing the test on error.
func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	return string(b)
}

// ---------------------------------------------------------------------------
// Single-edit mode
// ---------------------------------------------------------------------------

func TestEditFile_BasicReplace(t *testing.T) {
	path := writeTemp(t, "hello world\n")
	diff, err := EditFile(path, "world", "Go", EditOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := readFile(t, path)
	if got != "hello Go\n" {
		t.Errorf("file content = %q, want %q", got, "hello Go\n")
	}
	if !strings.Contains(diff, "-") || !strings.Contains(diff, "+") {
		t.Errorf("diff does not contain +/- lines: %q", diff)
	}
}

func TestEditFile_MultilineReplace(t *testing.T) {
	original := "line1\nline2\nline3\n"
	path := writeTemp(t, original)
	diff, err := EditFile(path, "line2\n", "replaced\n", EditOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := readFile(t, path)
	want := "line1\nreplaced\nline3\n"
	if got != want {
		t.Errorf("content = %q, want %q", got, want)
	}
	if !strings.Contains(diff, "replaced") {
		t.Errorf("diff missing added line: %q", diff)
	}
}

func TestEditFile_NotFound(t *testing.T) {
	path := writeTemp(t, "hello world\n")
	_, err := EditFile(path, "missing", "x", EditOpts{})
	if err == nil {
		t.Fatal("expected error for not-found oldText, got nil")
	}
	if !strings.Contains(err.Error(), "could not find") {
		t.Errorf("error message unexpected: %v", err)
	}
}

func TestEditFile_AmbiguousMatch(t *testing.T) {
	path := writeTemp(t, "foo bar foo\n")
	_, err := EditFile(path, "foo", "baz", EditOpts{})
	if err == nil {
		t.Fatal("expected error for ambiguous oldText, got nil")
	}
	if !strings.Contains(err.Error(), "occurrences") {
		t.Errorf("error message unexpected: %v", err)
	}
}

func TestEditFile_EmptyOldText(t *testing.T) {
	path := writeTemp(t, "content\n")
	_, err := EditFile(path, "", "x", EditOpts{})
	if err == nil {
		t.Fatal("expected error for empty oldText, got nil")
	}
	if !strings.Contains(err.Error(), "empty") {
		t.Errorf("error message unexpected: %v", err)
	}
}

func TestEditFile_FileNotFound(t *testing.T) {
	_, err := EditFile("/nonexistent/path/file.txt", "old", "new", EditOpts{})
	if err == nil {
		t.Fatal("expected error for missing file, got nil")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("error message unexpected: %v", err)
	}
}

func TestEditFile_NoChangeError(t *testing.T) {
	// When oldText == newText the content doesn't change; should return error.
	path := writeTemp(t, "foo bar\n")
	_, err := EditFile(path, "foo", "foo", EditOpts{})
	if err == nil {
		t.Fatal("expected no-change error, got nil")
	}
	if !strings.Contains(err.Error(), "no changes") {
		t.Errorf("error message unexpected: %v", err)
	}
}

func TestEditFile_EmptyNewText_Deletion(t *testing.T) {
	// newText="" is a deletion — valid as long as something changes.
	path := writeTemp(t, "prefix-MARKER-suffix\n")
	_, err := EditFile(path, "-MARKER", "", EditOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := readFile(t, path)
	if got != "prefix-suffix\n" {
		t.Errorf("content = %q, want %q", got, "prefix-suffix\n")
	}
}

func TestEditFile_PreservesCRLF(t *testing.T) {
	path := writeTemp(t, "line1\r\nline2\r\nline3\r\n")
	_, err := EditFile(path, "line2", "replaced", EditOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := readFile(t, path)
	want := "line1\r\nreplaced\r\nline3\r\n"
	if got != want {
		t.Errorf("CRLF not preserved: got %q, want %q", got, want)
	}
}

func TestEditFile_PreservesBOM(t *testing.T) {
	// BOM should be stripped before matching and re-prepended on write.
	bom := "\uFEFF"
	path := writeTemp(t, bom+"content here\n")
	_, err := EditFile(path, "content", "replaced", EditOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := readFile(t, path)
	want := bom + "replaced here\n"
	if got != want {
		t.Errorf("BOM not preserved: got %q, want %q", got, want)
	}
}

// ---------------------------------------------------------------------------
// Multi-edit mode
// ---------------------------------------------------------------------------

func TestEditFileMulti_TwoNonOverlapping(t *testing.T) {
	original := "alpha beta gamma\n"
	path := writeTemp(t, original)
	edits := []SingleEdit{
		{OldText: "alpha", NewText: "ALPHA"},
		{OldText: "gamma", NewText: "GAMMA"},
	}
	diff, err := EditFileMulti(path, edits, EditOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := readFile(t, path)
	want := "ALPHA beta GAMMA\n"
	if got != want {
		t.Errorf("content = %q, want %q", got, want)
	}
	if !strings.Contains(diff, "ALPHA") || !strings.Contains(diff, "GAMMA") {
		t.Errorf("diff does not mention both replacements: %q", diff)
	}
}

func TestEditFileMulti_MatchedAgainstOriginal(t *testing.T) {
	// If edits were applied incrementally, the second edit might fail or
	// produce wrong output. Applied against original, both must succeed.
	original := "foo baz\nfoo qux\n"
	path := writeTemp(t, original)

	// Replace two distinct, non-ambiguous occurrences each on their own line.
	edits := []SingleEdit{
		{OldText: "foo baz", NewText: "A"},
		{OldText: "foo qux", NewText: "B"},
	}
	_, err := EditFileMulti(path, edits, EditOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := readFile(t, path)
	want := "A\nB\n"
	if got != want {
		t.Errorf("content = %q, want %q", got, want)
	}
}

func TestEditFileMulti_OverlappingEditsError(t *testing.T) {
	path := writeTemp(t, "abcdef\n")
	// Both edits match overlapping regions: "abc" and "bcd" overlap.
	edits := []SingleEdit{
		{OldText: "abc", NewText: "X"},
		{OldText: "bcd", NewText: "Y"},
	}
	_, err := EditFileMulti(path, edits, EditOpts{})
	if err == nil {
		t.Fatal("expected overlap error, got nil")
	}
	if !strings.Contains(err.Error(), "overlap") {
		t.Errorf("error message unexpected: %v", err)
	}
}

func TestEditFileMulti_CorrectOrderingBottomToTop(t *testing.T) {
	// Edits are provided in reverse position order; they must still be applied
	// correctly (bottom-to-top after sorting by position).
	original := "line1\nline2\nline3\n"
	path := writeTemp(t, original)
	edits := []SingleEdit{
		{OldText: "line3", NewText: "THREE"}, // later in file
		{OldText: "line1", NewText: "ONE"},   // earlier in file
	}
	_, err := EditFileMulti(path, edits, EditOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := readFile(t, path)
	want := "ONE\nline2\nTHREE\n"
	if got != want {
		t.Errorf("content = %q, want %q", got, want)
	}
}

func TestEditFileMulti_EmptyEdits(t *testing.T) {
	path := writeTemp(t, "content\n")
	_, err := EditFileMulti(path, []SingleEdit{}, EditOpts{})
	if err == nil {
		t.Fatal("expected error for empty edits slice, got nil")
	}
}

func TestEditFileMulti_OneOfEditsNotFound(t *testing.T) {
	path := writeTemp(t, "hello world\n")
	edits := []SingleEdit{
		{OldText: "hello", NewText: "hi"},
		{OldText: "missing", NewText: "x"},
	}
	_, err := EditFileMulti(path, edits, EditOpts{})
	if err == nil {
		t.Fatal("expected error when one edit not found, got nil")
	}
	if !strings.Contains(err.Error(), "edits[1]") {
		t.Errorf("error should reference edits[1]: %v", err)
	}
}

func TestEditFileMulti_AmbiguousEditInMultiMode(t *testing.T) {
	// "foo" appears twice in a two-edit call → error must reference edits[0].
	path := writeTemp(t, "foo bar foo\nbaz\n")
	edits := []SingleEdit{
		{OldText: "foo", NewText: "X"},
		{OldText: "baz", NewText: "Y"},
	}
	_, err := EditFileMulti(path, edits, EditOpts{})
	if err == nil {
		t.Fatal("expected ambiguity error, got nil")
	}
	if !strings.Contains(err.Error(), "edits[0]") {
		t.Errorf("error should reference edits[0]: %v", err)
	}
}

func TestEditFileMulti_AmbiguousEditSingular(t *testing.T) {
	// Single-edit call (even via EditFileMulti) uses the singular error form
	// (no "edits[N]" in the message) — mirrors the JS reference behaviour.
	path := writeTemp(t, "foo bar foo\n")
	_, err := EditFileMulti(path, []SingleEdit{{OldText: "foo", NewText: "X"}}, EditOpts{})
	if err == nil {
		t.Fatal("expected ambiguity error, got nil")
	}
	if !strings.Contains(err.Error(), "occurrences") {
		t.Errorf("error message unexpected: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

func TestEditFile_FuzzySmartQuotes(t *testing.T) {
	// File contains a smart left-double-quote; oldText uses ASCII double quote.
	content := "say \u201Chello\u201D world\n"
	path := writeTemp(t, content)
	_, err := EditFile(path, `say "hello" world`, "replaced", EditOpts{})
	if err != nil {
		t.Fatalf("fuzzy smart-quote match failed: %v", err)
	}
	got := readFile(t, path)
	if got != "replaced\n" {
		t.Errorf("content = %q, want %q", got, "replaced\n")
	}
}

func TestEditFile_FuzzyTrailingWhitespace(t *testing.T) {
	// File has trailing spaces on the line; oldText does not.
	content := "hello   \nworld\n"
	path := writeTemp(t, content)
	_, err := EditFile(path, "hello\nworld", "replaced", EditOpts{})
	if err != nil {
		t.Fatalf("fuzzy trailing-whitespace match failed: %v", err)
	}
	got := readFile(t, path)
	if got != "replaced\n" {
		t.Errorf("content = %q, want %q", got, "replaced\n")
	}
}

// ---------------------------------------------------------------------------
// Path confinement
// ---------------------------------------------------------------------------

func TestEditFile_AllowedRoots_Inside(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file.txt")
	if err := os.WriteFile(path, []byte("content\n"), 0644); err != nil {
		t.Fatal(err)
	}
	_, err := EditFile(path, "content", "replaced", EditOpts{AllowedRoots: []string{dir}})
	if err != nil {
		t.Fatalf("unexpected error for allowed path: %v", err)
	}
}

func TestEditFile_AllowedRoots_Outside(t *testing.T) {
	dir := t.TempDir()
	allowedDir := t.TempDir()
	path := filepath.Join(dir, "file.txt")
	if err := os.WriteFile(path, []byte("content\n"), 0644); err != nil {
		t.Fatal(err)
	}
	// allowedDir is different from dir — path is outside allowed roots.
	_, err := EditFile(path, "content", "replaced", EditOpts{AllowedRoots: []string{allowedDir}})
	if err == nil {
		t.Fatal("expected confinement error, got nil")
	}
	if !strings.Contains(err.Error(), "outside") {
		t.Errorf("error message unexpected: %v", err)
	}
}

func TestEditFile_CWD_RelativePath(t *testing.T) {
	dir := t.TempDir()
	absPath := filepath.Join(dir, "file.txt")
	if err := os.WriteFile(absPath, []byte("hello\n"), 0644); err != nil {
		t.Fatal(err)
	}
	// Edit using relative path + CWD.
	_, err := EditFile("file.txt", "hello", "world", EditOpts{CWD: dir})
	if err != nil {
		t.Fatalf("unexpected error with CWD: %v", err)
	}
	if got := readFile(t, absPath); got != "world\n" {
		t.Errorf("content = %q, want %q", got, "world\n")
	}
}

// ---------------------------------------------------------------------------
// Diff output format
// ---------------------------------------------------------------------------

func TestEditFile_DiffContainsPlusMinusLines(t *testing.T) {
	path := writeTemp(t, "old line\n")
	diff, err := EditFile(path, "old line", "new line", EditOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(diff, "-") {
		t.Errorf("diff missing '-' line: %q", diff)
	}
	if !strings.Contains(diff, "+") {
		t.Errorf("diff missing '+' line: %q", diff)
	}
	if !strings.Contains(diff, "old line") {
		t.Errorf("diff missing old text: %q", diff)
	}
	if !strings.Contains(diff, "new line") {
		t.Errorf("diff missing new text: %q", diff)
	}
}

func TestEditFile_DiffLineNumbers(t *testing.T) {
	// Change is on line 3 — the diff should reflect that.
	path := writeTemp(t, "line1\nline2\nTARGET\nline4\n")
	diff, err := EditFile(path, "TARGET", "REPLACED", EditOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// The diff should contain a line-number indicator for line 3.
	if !strings.Contains(diff, "3") {
		t.Errorf("diff should mention line 3: %q", diff)
	}
}

func TestEditFile_DiffContext_Ellipsis(t *testing.T) {
	// Build a file big enough that context lines get elided with "...".
	var sb strings.Builder
	for i := 1; i <= 20; i++ {
		sb.WriteString("line\n")
	}
	sb.WriteString("TARGET\n")
	for i := 1; i <= 20; i++ {
		sb.WriteString("line\n")
	}
	path := writeTemp(t, sb.String())
	diff, err := EditFile(path, "TARGET", "REPLACED", EditOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(diff, "...") {
		t.Errorf("diff should contain ellipsis for long context: %q", diff)
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

func TestDetectLineEnding(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"a\nb", "\n"},
		{"a\r\nb", "\r\n"},
		{"a\r\nb\nc", "\r\n"}, // first \r\n comes before first lone \n
		{"a\nb\r\nc", "\n"},   // first \n comes before first \r\n
		{"no newlines", "\n"},
	}
	for _, tc := range tests {
		got := detectLineEnding(tc.input)
		if got != tc.want {
			t.Errorf("detectLineEnding(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestNormalizeToLF(t *testing.T) {
	if got := normalizeToLF("a\r\nb\rc"); got != "a\nb\nc" {
		t.Errorf("normalizeToLF: got %q, want %q", got, "a\nb\nc")
	}
}

func TestStripBOM(t *testing.T) {
	bom, text := stripBOM("\uFEFFhello")
	if bom != "\uFEFF" || text != "hello" {
		t.Errorf("stripBOM with BOM: bom=%q text=%q", bom, text)
	}
	bom2, text2 := stripBOM("hello")
	if bom2 != "" || text2 != "hello" {
		t.Errorf("stripBOM without BOM: bom=%q text=%q", bom2, text2)
	}
}

func TestCountOccurrences(t *testing.T) {
	if got := countOccurrences("foo bar foo", "foo"); got != 2 {
		t.Errorf("countOccurrences: got %d, want 2", got)
	}
	if got := countOccurrences("hello world", "missing"); got != 0 {
		t.Errorf("countOccurrences missing: got %d, want 0", got)
	}
}

func TestSplitIntoLines(t *testing.T) {
	tests := []struct {
		input string
		want  []string
	}{
		{"", []string{""}},
		{"abc", []string{"abc"}},
		{"a\nb", []string{"a\n", "b"}},
		{"a\nb\n", []string{"a\n", "b\n", ""}},
	}
	for _, tc := range tests {
		got := splitIntoLines(tc.input)
		if len(got) != len(tc.want) {
			t.Errorf("splitIntoLines(%q) len=%d want %d: %v", tc.input, len(got), len(tc.want), got)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("splitIntoLines(%q)[%d] = %q, want %q", tc.input, i, got[i], tc.want[i])
			}
		}
	}
}

func TestNormalizeForFuzzyMatch_SmartQuotes(t *testing.T) {
	input := "\u201Chello\u201D"
	got := normalizeForFuzzyMatch(input)
	if got != `"hello"` {
		t.Errorf("normalizeForFuzzyMatch smart quotes: got %q, want %q", got, `"hello"`)
	}
}

func TestNormalizeForFuzzyMatch_Dashes(t *testing.T) {
	// U+2013 en-dash → ASCII hyphen
	input := "a\u2013b"
	got := normalizeForFuzzyMatch(input)
	if got != "a-b" {
		t.Errorf("normalizeForFuzzyMatch dash: got %q, want %q", got, "a-b")
	}
}

func TestNormalizeForFuzzyMatch_TrailingWhitespace(t *testing.T) {
	input := "hello   \nworld  "
	got := normalizeForFuzzyMatch(input)
	if got != "hello\nworld" {
		t.Errorf("normalizeForFuzzyMatch trailing ws: got %q, want %q", got, "hello\nworld")
	}
}
