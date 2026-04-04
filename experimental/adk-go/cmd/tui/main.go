// Command tui starts the Bubble Tea TUI for the ADK Go runner.
//
// In local mode (default), it spawns a provider (e.g. claude CLI) directly
// and runs an interactive coding agent session in the terminal.
//
// In relay mode (--relay-url), it connects to a PizzaPi relay server and
// displays a remote session.
//
// Usage:
//
//	# Local mode (Claude Code equivalent)
//	go run ./cmd/tui "explain this codebase"
//
//	# Relay mode (remote session viewer)
//	PIZZAPI_API_KEY=<key> go run ./cmd/tui --relay-url http://localhost:7492 --session-id <id>
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/runner"
	"github.com/Pizzaface/PizzaPi/experimental/adk-go/tui"
)

func main() {
	relayURL := flag.String("relay-url", "", "PizzaPi relay URL (enables relay mode)")
	apiKey := flag.String("api-key", "", "PizzaPi API key (default: PIZZAPI_API_KEY env)")
	sessionID := flag.String("session-id", "", "Session ID to watch (relay mode only)")
	provider := flag.String("provider", "claude-cli", "Provider name (local mode only)")
	model := flag.String("model", "", "Model ID (e.g. claude-sonnet-4-20250514)")
	cwd := flag.String("cwd", "", "Working directory (default: current directory)")
	flag.Parse()

	// Resolve working directory
	workDir := *cwd
	if workDir == "" {
		workDir, _ = os.Getwd()
	}

	// Resolve API key
	key := *apiKey
	if key == "" {
		key = os.Getenv("PIZZAPI_API_KEY")
	}
	if key == "" {
		key = os.Getenv("PIZZAPI_API_TOKEN")
	}

	// Resolve relay URL
	url := *relayURL
	if url == "" {
		url = os.Getenv("PIZZAPI_RELAY_URL")
	}

	// Determine mode
	var session tui.SessionController
	if url != "" {
		// Relay mode
		session = tui.NewRemoteSession(url, key, *sessionID)
	} else {
		// Local mode — create provider from registry
		factory, err := runner.DefaultRegistry.Get(*provider)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
		p := factory()
		session = tui.NewLocalSession(p, workDir, *model)
	}

	// Collect initial prompt from positional args
	prompt := strings.Join(flag.Args(), " ")

	app := tui.New(session)
	if prompt != "" {
		app = app.WithInitialPrompt(prompt)
	}

	p := tea.NewProgram(app, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		log.Fatalf("error: %v", err)
	}
}
