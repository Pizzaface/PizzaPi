package adk

import (
	"google.golang.org/adk/tool"
	"google.golang.org/adk/tool/functiontool"

	coretools "github.com/Pizzaface/PizzaPi/experimental/adk-go/tools"
)

type readArgs struct {
	Path   string `json:"path" jsonschema:"Path to the file to read (relative or absolute)."`
	Offset int    `json:"offset,omitempty" jsonschema:"Line number to start reading from (1-indexed)."`
	Limit  int    `json:"limit,omitempty" jsonschema:"Maximum number of lines to read."`
}

type readResult struct {
	Content   string `json:"content"`
	Truncated bool   `json:"truncated,omitempty"`
	TotalLine int    `json:"totalLines,omitempty"`
}

// NewReadTool creates an ADK function tool for reading files.
func NewReadTool(cwd string) (tool.Tool, error) {
	return functiontool.New(
		functiontool.Config{
			Name: "read",
			Description: "Read the contents of a file. Supports text files. " +
				"Output is truncated to 2000 lines or 50KB. " +
				"Use offset/limit for large files.",
		},
		func(ctx tool.Context, args readArgs) (readResult, error) {
			path := resolvePath(args.Path, cwd)
			content, err := coretools.ReadFile(path, coretools.ReadOpts{
				Offset: args.Offset,
				Limit:  args.Limit,
			})
			if err != nil {
				return readResult{}, err
			}
			return readResult{
				Content:   content.Content,
				Truncated: content.Truncated,
				TotalLine: content.TotalLines,
			}, nil
		},
	)
}
