package tools_test

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/tools"
)

func skipIfNoSymlinks(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("symlinks may not work on Windows without elevated privileges")
	}
}

// --- ReadFile path confinement integration ---

func TestReadFile_PathConfinement_WithinRoot(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "file.txt")
	if err := os.WriteFile(file, []byte("safe content\n"), 0644); err != nil {
		t.Fatal(err)
	}
	result, err := tools.ReadFile(file, tools.ReadOpts{AllowedRoots: []string{dir}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Content != "safe content\n" {
		t.Errorf("unexpected content: %q", result.Content)
	}
}

func TestReadFile_PathConfinement_OutsideRoot(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	file := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(file, []byte("secret"), 0644); err != nil {
		t.Fatal(err)
	}
	_, err := tools.ReadFile(file, tools.ReadOpts{AllowedRoots: []string{dir}})
	if err == nil {
		t.Error("expected error: path is outside allowed root")
	}
}

func TestReadFile_PathConfinement_TraversalBlocked(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	secretFile := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secretFile, []byte("secret"), 0644); err != nil {
		t.Fatal(err)
	}
	traversal := filepath.Join(root, "..", filepath.Base(outside), "secret.txt")
	_, err := tools.ReadFile(traversal, tools.ReadOpts{AllowedRoots: []string{root}})
	if err == nil {
		t.Error("expected error: traversal path escapes allowed root")
	}
}

func TestReadFile_PathConfinement_SymlinkOutsideRoot(t *testing.T) {
	skipIfNoSymlinks(t)
	root := t.TempDir()
	outside := t.TempDir()
	secretFile := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secretFile, []byte("secret"), 0644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link.txt")
	if err := os.Symlink(secretFile, link); err != nil {
		t.Fatal(err)
	}
	_, err := tools.ReadFile(link, tools.ReadOpts{AllowedRoots: []string{root}})
	if err == nil {
		t.Error("expected error: symlink points outside allowed root")
	}
}

func TestReadFile_PathConfinement_NoRoots_BackwardCompat(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "file.txt")
	if err := os.WriteFile(file, []byte("hello\n"), 0644); err != nil {
		t.Fatal(err)
	}
	result, err := tools.ReadFile(file, tools.ReadOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Content != "hello\n" {
		t.Errorf("unexpected content: %q", result.Content)
	}
}

// --- WriteFile path confinement integration ---

func TestWriteFile_PathConfinement_WithinRoot(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "out.txt")
	if err := os.WriteFile(file, []byte(""), 0644); err != nil {
		t.Fatal(err)
	}
	err := tools.WriteFile(file, "new content", tools.WriteOpts{AllowedRoots: []string{dir}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestWriteFile_PathConfinement_OutsideRoot(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	file := filepath.Join(outside, "file.txt")
	if err := os.WriteFile(file, []byte("existing"), 0644); err != nil {
		t.Fatal(err)
	}
	err := tools.WriteFile(file, "evil", tools.WriteOpts{AllowedRoots: []string{dir}})
	if err == nil {
		t.Error("expected error: path is outside allowed root")
	}
}

func TestWriteFile_PathConfinement_SymlinkOutsideRoot(t *testing.T) {
	skipIfNoSymlinks(t)
	root := t.TempDir()
	outside := t.TempDir()
	target := filepath.Join(outside, "target.txt")
	if err := os.WriteFile(target, []byte("original"), 0644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	err := tools.WriteFile(link, "evil", tools.WriteOpts{AllowedRoots: []string{root}})
	if err == nil {
		t.Error("expected error: symlink points outside allowed root")
	}
}

func TestWriteFile_PathConfinement_NoOpts_BackwardCompat(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "file.txt")
	if err := tools.WriteFile(file, "hello"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
