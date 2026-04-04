package adk

import (
	"fmt"

	"google.golang.org/adk/tool"
	"google.golang.org/adk/tool/functiontool"

	coretools "github.com/Pizzaface/PizzaPi/experimental/adk-go/tools"
)

type editArgs struct {
	Path    string `json:"path" jsonschema:"Path to the file to edit (relative or absolute)."`
	OldText string `json:"oldText" jsonschema:"Exact text to replace. Must be unique in the file."`
	NewText string `json:"newText" jsonschema:"Replacement text."`
}

type editResult struct {
	Success bool   `json:"success"`
	Diff    string `json:"diff,omitempty"`
	Message string `json:"message,omitempty"`
}

// NewEditTool creates an ADK function tool for precise file edits.
func NewEditTool(cwd string) (tool.Tool, error) {
	return functiontool.New(
		functiontool.Config{
			Name: "edit",
			Description: "Edit a file using exact text replacement. " +
				"The oldText must match exactly one location in the file. " +
				"Use for precise, surgical changes.",
		},
		func(ctx tool.Context, args editArgs) (editResult, error) {
			path := resolvePath(args.Path, cwd)
			diff, err := coretools.EditFile(path, args.OldText, args.NewText, coretools.EditOpts{})
			if err != nil {
				return editResult{Success: false, Message: err.Error()}, nil
			}
			return editResult{
				Success: true,
				Diff:    diff,
				Message: fmt.Sprintf("Successfully edited %s", args.Path),
			}, nil
		},
	)
}
