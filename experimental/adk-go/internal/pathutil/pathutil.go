package pathutil

import (
	"fmt"
	"path/filepath"
	"strings"
)

// ResolvePath resolves path to an absolute, symlink-free canonical path.
// If path is relative, it is joined with cwd before resolution.
// If path is absolute, cwd is ignored.
// filepath.EvalSymlinks is called to canonicalize the result and resolve any
// symlinks. The target must exist for symlink resolution to succeed.
func ResolvePath(path, cwd string) (string, error) {
	if !filepath.IsAbs(path) {
		if cwd == "" {
			return "", fmt.Errorf("relative path %q requires a non-empty cwd", path)
		}
		path = filepath.Join(cwd, path)
	}

	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("resolving path %q: %w", path, err)
	}
	return resolved, nil
}

// resolvePathForWrite resolves path to an absolute, symlink-free canonical
// path, supporting paths that do not yet exist (e.g., new files to be
// created by WriteFile). If the target path exists, it behaves identically to
// ResolvePath. If the target does not exist, it walks up the directory tree to
// find the deepest existing ancestor, resolves symlinks on that ancestor, then
// reconstructs the full resolved path by appending the non-existent suffix
// components. This prevents a catch-22 where confinement check fires before the
// file can be created.
func ResolvePathForWrite(path, cwd string) (string, error) {
	if !filepath.IsAbs(path) {
		if cwd == "" {
			return "", fmt.Errorf("relative path %q requires a non-empty cwd", path)
		}
		path = filepath.Join(cwd, path)
	}
	// Normalize ".." and redundant separators before walking.
	path = filepath.Clean(path)

	// Fast path: target exists — resolve directly (handles symlinks too).
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved, nil
	}

	// Target doesn't exist yet. Walk up to find the deepest existing ancestor.
	var suffix []string
	current := path
	for {
		parent := filepath.Dir(current)
		if parent == current {
			// Reached the filesystem root without finding any existing ancestor.
			return "", fmt.Errorf("resolving path %q: no existing ancestor directory found", path)
		}
		suffix = append([]string{filepath.Base(current)}, suffix...)
		current = parent

		if resolved, err := filepath.EvalSymlinks(current); err == nil {
			// Reconstruct: resolved ancestor + non-existent suffix components.
			parts := append([]string{resolved}, suffix...)
			return filepath.Join(parts...), nil
		}
	}
}

// ValidatePathWithinRoots checks that resolved is within at least one of the
// allowedRoots directories. Returns an error if resolved is outside every
// allowed root. If allowedRoots is empty, the check is skipped and nil is
// returned (backward-compatible: no roots = no confinement).
//
// Each root is canonicalized via filepath.EvalSymlinks before comparison so
// that platform-level symlinks (e.g. /var → /private/var on macOS) do not
// cause spurious rejections.
func ValidatePathWithinRoots(resolved string, allowedRoots []string) error {
	if len(allowedRoots) == 0 {
		return nil
	}
	for _, root := range allowedRoots {
		// Best-effort canonicalization of the root; fall back to the original
		// string if EvalSymlinks fails (e.g. root doesn't exist yet).
		if canon, err := filepath.EvalSymlinks(root); err == nil {
			root = canon
		}
		rel, err := filepath.Rel(root, resolved)
		if err != nil {
			continue
		}
		// If the relative path does not start with "..", resolved is within root.
		if !strings.HasPrefix(rel, "..") {
			return nil
		}
	}
	return fmt.Errorf("path %q is outside allowed roots %v", resolved, allowedRoots)
}
