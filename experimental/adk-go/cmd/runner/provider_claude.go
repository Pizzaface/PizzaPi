// Package main re-exports ClaudeCLIProvider from internal/runner.
package main

import (
	"log"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/runner"
)

// NewClaudeCLIProvider creates a new Claude CLI provider.
func NewClaudeCLIProvider(logger *log.Logger) *runner.ClaudeCLIProvider {
	return runner.NewClaudeCLIProvider(logger)
}
