package tools_test

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/tools"
)

func TestWriteFile_CreatesParentDirs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a", "b", "c", "file.txt")
	content := "hello world"

	if err := tools.WriteFile(path, content); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("could not read written file: %v", err)
	}
	if string(data) != content {
		t.Errorf("expected %q, got %q", content, string(data))
	}
}

func TestWriteFile_OverwritesExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file.txt")

	if err := os.WriteFile(path, []byte("old content"), 0644); err != nil {
		t.Fatal(err)
	}

	newContent := "new content"
	if err := tools.WriteFile(path, newContent); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("could not read written file: %v", err)
	}
	if string(data) != newContent {
		t.Errorf("expected %q, got %q", newContent, string(data))
	}
}

func TestWriteFile_EmptyContent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.txt")

	if err := tools.WriteFile(path, ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("could not read written file: %v", err)
	}
	if len(data) != 0 {
		t.Errorf("expected empty file, got %d bytes", len(data))
	}
}

func TestWriteFile_WriteToDirectory(t *testing.T) {
	dir := t.TempDir()
	// Attempt to write content to a path that is an existing directory
	err := tools.WriteFile(dir, "some content")
	if err == nil {
		t.Error("expected error when writing to a directory path")
	}
}

func TestWriteFile_FileMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file.txt")

	if err := tools.WriteFile(path, "content"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat error: %v", err)
	}
	// Check file permissions are 0644
	got := info.Mode().Perm()
	if got != 0644 {
		t.Errorf("expected mode 0644, got %04o", got)
	}
}

func TestWriteFile_DirMode(t *testing.T) {
	dir := t.TempDir()
	subdir := filepath.Join(dir, "newdir")
	path := filepath.Join(subdir, "file.txt")

	if err := tools.WriteFile(path, "content"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	info, err := os.Stat(subdir)
	if err != nil {
		t.Fatalf("stat error: %v", err)
	}
	// Check directory permissions are at least 0755 (umask may restrict)
	got := info.Mode().Perm()
	if got&0755 != 0755 {
		t.Errorf("expected dir mode to have at least 0755, got %04o", got)
	}
}

// --- New-file confinement tests (fix for the EvalSymlinks catch-22) ---

// TestWriteFile_NewFile_WithinRoot verifies that WriteFile can create a brand
// new file that doesn't exist yet when AllowedRoots is set. This was broken
// before the ancestor-walk fix because EvalSymlinks failed on non-existent paths.
func TestWriteFile_NewFile_WithinRoot(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "brand_new.txt")

	// file does NOT exist before this call — this was the broken case.
	err := tools.WriteFile(file, "hello", tools.WriteOpts{
		AllowedRoots: []string{dir},
	})
	if err != nil {
		t.Fatalf("unexpected error writing new file within root: %v", err)
	}

	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("could not read written file: %v", err)
	}
	if string(data) != "hello" {
		t.Errorf("expected %q, got %q", "hello", string(data))
	}
}

// TestWriteFile_NewFile_SubdirAutoMkdir verifies that WriteFile can create a
// new file inside a non-existent subdirectory, with AllowedRoots enforced.
func TestWriteFile_NewFile_SubdirAutoMkdir(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "subdir", "new.txt")

	// Neither "subdir" nor "new.txt" exist — WriteFile must create both.
	err := tools.WriteFile(file, "hello", tools.WriteOpts{
		AllowedRoots: []string{dir},
	})
	if err != nil {
		t.Fatalf("unexpected error writing new file in new subdir: %v", err)
	}

	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("could not read written file: %v", err)
	}
	if string(data) != "hello" {
		t.Errorf("expected %q, got %q", "hello", string(data))
	}
}

// TestWriteFile_NewFile_TraversalEscape verifies that a path using ".." to
// escape the allowed root is rejected even for a file that doesn't exist yet.
func TestWriteFile_NewFile_TraversalEscape(t *testing.T) {
	dir := t.TempDir()
	// filepath.Join cleans "..", so this resolves to parent(dir)/escape.txt,
	// which is outside the allowed root.
	escapePath := filepath.Join(dir, "..", "escape.txt")

	err := tools.WriteFile(escapePath, "evil", tools.WriteOpts{
		AllowedRoots: []string{dir},
	})
	if err == nil {
		t.Error("expected confinement error for path escaping via '..', got nil")
	}
}

// TestWriteFile_NewFile_SymlinkOutsideRoot verifies that a symlink inside the
// allowed root pointing to a location outside is still rejected.
func TestWriteFile_NewFile_SymlinkOutsideRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink tests require elevated privileges on Windows")
	}

	root := t.TempDir()
	outside := t.TempDir()

	// Create a real target outside the root.
	target := filepath.Join(outside, "target.txt")
	if err := os.WriteFile(target, []byte("original"), 0644); err != nil {
		t.Fatal(err)
	}

	// Symlink inside root pointing to the file outside root.
	link := filepath.Join(root, "link.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}

	err := tools.WriteFile(link, "evil", tools.WriteOpts{
		AllowedRoots: []string{root},
	})
	if err == nil {
		t.Error("expected confinement error for symlink pointing outside root, got nil")
	}
}
