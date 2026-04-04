package tools_test

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/pizzaface/pizzapi/experimental/adk-go/runtime/tools"
)

// skipIfNoSymlinks skips the test on platforms where os.Symlink may not work
// (e.g., Windows without elevated privileges).
func skipIfNoSymlinks(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("symlink tests require elevated privileges on Windows")
	}
}

// --- ResolvePath ---

func TestResolvePath_AbsolutePath(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "file.txt")
	if err := os.WriteFile(file, []byte("hi"), 0644); err != nil {
		t.Fatal(err)
	}

	got, err := tools.ResolvePath(file, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// EvalSymlinks may change the path on some systems (e.g., /var -> /private/var on macOS)
	// so compare via Lstat rather than string equality.
	gotInfo, err := os.Lstat(got)
	if err != nil {
		t.Fatalf("resolved path %q does not exist: %v", got, err)
	}
	origInfo, err := os.Lstat(file)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(gotInfo, origInfo) {
		t.Errorf("resolved path %q differs from original %q", got, file)
	}
}

func TestResolvePath_RelativePath(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "file.txt")
	if err := os.WriteFile(file, []byte("hi"), 0644); err != nil {
		t.Fatal(err)
	}

	got, err := tools.ResolvePath("file.txt", dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	gotInfo, _ := os.Lstat(got)
	origInfo, _ := os.Lstat(file)
	if !os.SameFile(gotInfo, origInfo) {
		t.Errorf("resolved path %q differs from original %q", got, file)
	}
}

func TestResolvePath_RelativePathNoCWD(t *testing.T) {
	_, err := tools.ResolvePath("relative/path.txt", "")
	if err == nil {
		t.Error("expected error for relative path with empty cwd")
	}
}

func TestResolvePath_NonExistent(t *testing.T) {
	_, err := tools.ResolvePath("/nonexistent/does/not/exist.txt", "")
	if err == nil {
		t.Error("expected error for non-existent path")
	}
}

func TestResolvePath_SymlinkResolved(t *testing.T) {
	skipIfNoSymlinks(t)

	dir := t.TempDir()
	realFile := filepath.Join(dir, "real.txt")
	if err := os.WriteFile(realFile, []byte("data"), 0644); err != nil {
		t.Fatal(err)
	}
	linkFile := filepath.Join(dir, "link.txt")
	if err := os.Symlink(realFile, linkFile); err != nil {
		t.Fatal(err)
	}

	got, err := tools.ResolvePath(linkFile, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// The resolved path should point to the real file, not the symlink.
	gotInfo, _ := os.Lstat(got)
	realInfo, _ := os.Lstat(realFile)
	if !os.SameFile(gotInfo, realInfo) {
		t.Errorf("symlink was not resolved: got %q, want file equivalent to %q", got, realFile)
	}
}

// --- ValidatePathWithinRoots ---

func TestValidatePathWithinRoots_NoRoots(t *testing.T) {
	// No roots → no validation → always allowed.
	if err := tools.ValidatePathWithinRoots("/any/path", nil); err != nil {
		t.Errorf("expected nil with no roots, got %v", err)
	}
}

func TestValidatePathWithinRoots_WithinRoot(t *testing.T) {
	root := "/allowed/root"
	path := "/allowed/root/sub/file.txt"
	if err := tools.ValidatePathWithinRoots(path, []string{root}); err != nil {
		t.Errorf("expected allowed, got %v", err)
	}
}

func TestValidatePathWithinRoots_ExactRoot(t *testing.T) {
	root := "/allowed/root"
	if err := tools.ValidatePathWithinRoots(root, []string{root}); err != nil {
		t.Errorf("expected allowed for path equal to root, got %v", err)
	}
}

func TestValidatePathWithinRoots_OutsideRoot(t *testing.T) {
	root := "/allowed/root"
	path := "/other/place/file.txt"
	if err := tools.ValidatePathWithinRoots(path, []string{root}); err == nil {
		t.Error("expected error for path outside root")
	}
}

func TestValidatePathWithinRoots_TraversalEscape(t *testing.T) {
	root := "/allowed/root"
	// A manually crafted "../" traversal that goes above root.
	path := "/allowed/other"
	if err := tools.ValidatePathWithinRoots(path, []string{root}); err == nil {
		t.Error("expected error for path that escapes root via traversal")
	}
}

func TestValidatePathWithinRoots_MultipleRoots_FirstMatches(t *testing.T) {
	roots := []string{"/root1", "/root2"}
	path := "/root1/file.txt"
	if err := tools.ValidatePathWithinRoots(path, roots); err != nil {
		t.Errorf("expected allowed when path is in first root, got %v", err)
	}
}

func TestValidatePathWithinRoots_MultipleRoots_SecondMatches(t *testing.T) {
	roots := []string{"/root1", "/root2"}
	path := "/root2/sub/file.txt"
	if err := tools.ValidatePathWithinRoots(path, roots); err != nil {
		t.Errorf("expected allowed when path is in second root, got %v", err)
	}
}

func TestValidatePathWithinRoots_MultipleRoots_NoneMatch(t *testing.T) {
	roots := []string{"/root1", "/root2"}
	path := "/other/file.txt"
	if err := tools.ValidatePathWithinRoots(path, roots); err == nil {
		t.Error("expected error when path is outside all roots")
	}
}

// --- ReadFile path confinement integration ---

func TestReadFile_PathConfinement_WithinRoot(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "file.txt")
	if err := os.WriteFile(file, []byte("safe content\n"), 0644); err != nil {
		t.Fatal(err)
	}

	result, err := tools.ReadFile(file, tools.ReadOpts{
		AllowedRoots: []string{dir},
	})
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

	_, err := tools.ReadFile(file, tools.ReadOpts{
		AllowedRoots: []string{dir}, // outside is not in allowed roots
	})
	if err == nil {
		t.Error("expected error: path is outside allowed root")
	}
}

func TestReadFile_PathConfinement_TraversalBlocked(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	// Write a file outside root
	secretFile := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secretFile, []byte("secret"), 0644); err != nil {
		t.Fatal(err)
	}

	// Construct a path using "../" that would traverse outside root.
	traversal := filepath.Join(root, "..", filepath.Base(outside), "secret.txt")

	_, err := tools.ReadFile(traversal, tools.ReadOpts{
		AllowedRoots: []string{root},
	})
	if err == nil {
		t.Error("expected error: traversal path escapes allowed root")
	}
}

func TestReadFile_PathConfinement_SymlinkOutsideRoot(t *testing.T) {
	skipIfNoSymlinks(t)

	root := t.TempDir()
	outside := t.TempDir()

	// Create a real file outside root
	secretFile := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secretFile, []byte("secret"), 0644); err != nil {
		t.Fatal(err)
	}

	// Create a symlink inside root pointing to the file outside root
	link := filepath.Join(root, "link.txt")
	if err := os.Symlink(secretFile, link); err != nil {
		t.Fatal(err)
	}

	_, err := tools.ReadFile(link, tools.ReadOpts{
		AllowedRoots: []string{root},
	})
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

	// ReadOpts with no AllowedRoots — existing callers are not affected.
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
	// File must exist for ResolvePath (EvalSymlinks) to work, but WriteFile
	// creates it. For confinement, the parent dir is the anchor — test that
	// writing to an existing file within the root is allowed.
	if err := os.WriteFile(file, []byte(""), 0644); err != nil {
		t.Fatal(err)
	}

	err := tools.WriteFile(file, "new content", tools.WriteOpts{
		AllowedRoots: []string{dir},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestWriteFile_PathConfinement_OutsideRoot(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	file := filepath.Join(outside, "file.txt")
	// Create the file so EvalSymlinks can resolve it.
	if err := os.WriteFile(file, []byte("existing"), 0644); err != nil {
		t.Fatal(err)
	}

	err := tools.WriteFile(file, "evil", tools.WriteOpts{
		AllowedRoots: []string{dir},
	})
	if err == nil {
		t.Error("expected error: path is outside allowed root")
	}
}

func TestWriteFile_PathConfinement_SymlinkOutsideRoot(t *testing.T) {
	skipIfNoSymlinks(t)

	root := t.TempDir()
	outside := t.TempDir()

	// Create real target outside root
	target := filepath.Join(outside, "target.txt")
	if err := os.WriteFile(target, []byte("original"), 0644); err != nil {
		t.Fatal(err)
	}

	// Create symlink inside root pointing outside
	link := filepath.Join(root, "link.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}

	err := tools.WriteFile(link, "evil", tools.WriteOpts{
		AllowedRoots: []string{root},
	})
	if err == nil {
		t.Error("expected error: symlink points outside allowed root")
	}
}

func TestWriteFile_PathConfinement_NoOpts_BackwardCompat(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "file.txt")

	// Call without any opts — existing callers are not affected.
	if err := tools.WriteFile(file, "hello"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
