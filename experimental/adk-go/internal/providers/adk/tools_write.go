package adk

import (
	"fmt"

	"google.golang.org/adk/tool"
	"google.golang.org/adk/tool/functiontool"

	coretools "github.com/Pizzaface/PizzaPi/experimental/adk-go/tools"
)

type writeArgs struct {
	Path    string `json:"path" jsonschema:"Path to the file to write (relative or absolute)."`
	Content string `json:"content" jsonschema:"Content to write to the file."`
}

type writeResult struct {
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
}

// NewWriteTool creates an ADK function tool for writing files.
func NewWriteTool(cwd string) (tool.Tool, error) {
	return functiontool.New(
		functiontool.Config{
			Name: "write",
			Description: "Write content to a file. Creates the file if it doesn't exist, " +
				"overwrites if it does. Automatically creates parent directories.",
		},
		func(ctx tool.Context, args writeArgs) (writeResult, error) {
			path := resolvePath(args.Path, cwd)
			err := coretools.WriteFile(path, args.Content)
			if err != nil {
				return writeResult{Success: false, Message: err.Error()}, nil
			}
			return writeResult{
				Success: true,
				Message: fmt.Sprintf("Successfully wrote %s", args.Path),
			}, nil
		},
	)
}
