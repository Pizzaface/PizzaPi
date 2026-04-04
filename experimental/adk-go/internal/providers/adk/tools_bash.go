package adk

import (
	"time"

	"google.golang.org/adk/tool"
	"google.golang.org/adk/tool/functiontool"

	coretools "github.com/Pizzaface/PizzaPi/experimental/adk-go/tools"
)

type bashArgs struct {
	Command string `json:"command" jsonschema:"The bash command to execute."`
	Timeout int    `json:"timeout,omitempty" jsonschema:"Timeout in seconds (optional, default 120)."`
}

type bashResult struct {
	Output    string `json:"output"`
	ExitCode  int    `json:"exitCode"`
	Truncated bool   `json:"truncated,omitempty"`
	TimedOut  bool   `json:"timedOut,omitempty"`
}

// NewBashTool creates an ADK function tool for bash command execution.
func NewBashTool(cwd string) (tool.Tool, error) {
	return functiontool.New(
		functiontool.Config{
			Name: "bash",
			Description: "Execute a bash command in the working directory. Returns stdout/stderr. " +
				"Output is truncated to last 2000 lines or 50KB. " +
				"Optionally provide a timeout in seconds.",
		},
		func(ctx tool.Context, args bashArgs) (bashResult, error) {
			timeout := time.Duration(args.Timeout) * time.Second
			res, err := coretools.RunBash(args.Command, coretools.BashOpts{
				Timeout: timeout,
				Cwd:     cwd,
			})
			if err != nil {
				return bashResult{}, err
			}
			return bashResult{
				Output:    res.Output,
				ExitCode:  res.ExitCode,
				Truncated: res.Truncated,
				TimedOut:  res.TimedOut,
			}, nil
		},
	)
}
