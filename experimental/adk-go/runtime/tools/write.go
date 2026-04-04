package tools

import (
	"os"
	"path/filepath"
)

// WriteOpts controls path confinement for WriteFile.
type WriteOpts struct {
	// CWD is the working directory used to resolve relative paths.
	// Ignored when path is absolute. Required if path is relative and
	// AllowedRoots is non-empty.
	CWD string
	// AllowedRoots restricts which directories may be written to.
	// When non-empty, the resolved canonical path must fall within at least
	// one of these directories; otherwise WriteFile returns an error.
	// If empty, no path confinement is applied (backward compatible).
	AllowedRoots []string
}

// WriteFile writes content to path, creating parent directories as needed.
// Files are created with mode 0644; directories with mode 0755.
//
// When opts is provided and opts.AllowedRoots is non-empty, path is resolved
// to a canonical absolute path (symlinks expanded) and validated to fall
// within one of the allowed roots. Paths that escape the roots or dereference
// symlinks outside them are rejected. When AllowedRoots is empty (or opts is
// omitted), no confinement is applied (backward compatible).
func WriteFile(path string, content string, opts ...WriteOpts) error {
	if len(opts) > 0 && len(opts[0].AllowedRoots) > 0 {
		resolved, err := resolvePathForWrite(path, opts[0].CWD)
		if err != nil {
			return err
		}
		if err := ValidatePathWithinRoots(resolved, opts[0].AllowedRoots); err != nil {
			return err
		}
		path = resolved
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0644)
}
