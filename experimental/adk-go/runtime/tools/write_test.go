package tools_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/pizzaface/pizzapi/experimental/adk-go/runtime/tools"
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
