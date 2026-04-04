package tools

import (
	"os"
	"path/filepath"
)

// WriteFile writes content to path, creating parent directories as needed.
// Files are created with mode 0644; directories with mode 0755.
func WriteFile(path string, content string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0644)
}
