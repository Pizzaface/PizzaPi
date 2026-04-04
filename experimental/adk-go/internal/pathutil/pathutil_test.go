package pathutil_test

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/pathutil"
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

	got, err := pathutil.ResolvePath(file, "")
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

	got, err := pathutil.ResolvePath("file.txt", dir)
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
	_, err := pathutil.ResolvePath("relative/path.txt", "")
	if err == nil {
		t.Error("expected error for relative path with empty cwd")
	}
}

func TestResolvePath_NonExistent(t *testing.T) {
	_, err := pathutil.ResolvePath("/nonexistent/does/not/exist.txt", "")
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

	got, err := pathutil.ResolvePath(linkFile, "")
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
	if err := pathutil.ValidatePathWithinRoots("/any/path", nil); err != nil {
		t.Errorf("expected nil with no roots, got %v", err)
	}
}

func TestValidatePathWithinRoots_WithinRoot(t *testing.T) {
	root := "/allowed/root"
	path := "/allowed/root/sub/file.txt"
	if err := pathutil.ValidatePathWithinRoots(path, []string{root}); err != nil {
		t.Errorf("expected allowed, got %v", err)
	}
}

func TestValidatePathWithinRoots_ExactRoot(t *testing.T) {
	root := "/allowed/root"
	if err := pathutil.ValidatePathWithinRoots(root, []string{root}); err != nil {
		t.Errorf("expected allowed for path equal to root, got %v", err)
	}
}

func TestValidatePathWithinRoots_OutsideRoot(t *testing.T) {
	root := "/allowed/root"
	path := "/other/place/file.txt"
	if err := pathutil.ValidatePathWithinRoots(path, []string{root}); err == nil {
		t.Error("expected error for path outside root")
	}
}

func TestValidatePathWithinRoots_TraversalEscape(t *testing.T) {
	root := "/allowed/root"
	// A manually crafted "../" traversal that goes above root.
	path := "/allowed/other"
	if err := pathutil.ValidatePathWithinRoots(path, []string{root}); err == nil {
		t.Error("expected error for path that escapes root via traversal")
	}
}

func TestValidatePathWithinRoots_MultipleRoots_FirstMatches(t *testing.T) {
	roots := []string{"/root1", "/root2"}
	path := "/root1/file.txt"
	if err := pathutil.ValidatePathWithinRoots(path, roots); err != nil {
		t.Errorf("expected allowed when path is in first root, got %v", err)
	}
}

func TestValidatePathWithinRoots_MultipleRoots_SecondMatches(t *testing.T) {
	roots := []string{"/root1", "/root2"}
	path := "/root2/sub/file.txt"
	if err := pathutil.ValidatePathWithinRoots(path, roots); err != nil {
		t.Errorf("expected allowed when path is in second root, got %v", err)
	}
}

func TestValidatePathWithinRoots_MultipleRoots_NoneMatch(t *testing.T) {
	roots := []string{"/root1", "/root2"}
	path := "/other/file.txt"
	if err := pathutil.ValidatePathWithinRoots(path, roots); err == nil {
		t.Error("expected error when path is outside all roots")
	}
}
