// Command tui starts the Bubble Tea TUI for the ADK Go runner.
package main

import (
	"flag"
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/pizzaface/pizzapi/experimental/adk-go/tui"

	claudecli "github.com/pizzaface/pizzapi/experimental/adk-go/providers/claudecli"
)

// Compile-time assertion: verify the claudecli replace directive resolves and
// that ClaudeEvent is implemented by at least one concrete type we expect.
var _ claudecli.ClaudeEvent = (*claudecli.SystemEvent)(nil)

func main() {
	relayURL := flag.String("relay-url", "", "PizzaPi relay server URL (e.g. wss://relay.example.com)")
	apiKey := flag.String("api-key", "", "PizzaPi API key for relay authentication")
	flag.Parse()

	// TODO: establish relay connection using relayURL and apiKey.
	if *relayURL != "" {
		fmt.Fprintf(os.Stderr, "relay-url: %s (connection not yet implemented)\n", *relayURL)
	}
	if *apiKey != "" {
		fmt.Fprintf(os.Stderr, "api-key provided (connection not yet implemented)\n")
	}

	app := tui.New()
	p := tea.NewProgram(app, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "error running TUI: %v\n", err)
		os.Exit(1)
	}
}
