package adk

import (
	"path/filepath"
	"strings"

	"google.golang.org/adk/tool"
)

// AllTools returns all available ADK function tools configured for the given cwd.
// Returns tools and any errors encountered during tool creation.
func AllTools(cwd string) ([]tool.Tool, error) {
	builders := []func(string) (tool.Tool, error){
		NewBashTool,
		NewReadTool,
		NewWriteTool,
		NewEditTool,
	}

	var tools []tool.Tool
	for _, build := range builders {
		t, err := build(cwd)
		if err != nil {
			return nil, err
		}
		tools = append(tools, t)
	}
	return tools, nil
}

// resolvePath resolves a path relative to the working directory.
func resolvePath(path, cwd string) string {
	if filepath.IsAbs(path) {
		return path
	}
	if strings.HasPrefix(path, "~") {
		return path
	}
	return filepath.Join(cwd, path)
}
