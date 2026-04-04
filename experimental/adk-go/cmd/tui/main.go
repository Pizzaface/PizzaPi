// Command tui starts the Bubble Tea TUI for the ADK Go runner.
//
// It connects to a PizzaPi relay server and displays live session events
// in a terminal split-panel interface.
//
// Usage:
//
//	PIZZAPI_API_KEY=<key> go run ./cmd/tui --relay-url http://localhost:7492 --session-id <id>
package main

import (
	"flag"
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/tui"
)

func main() {
	relayURL := flag.String("relay-url", "", "PizzaPi relay server URL (e.g. http://localhost:7492)")
	apiKey := flag.String("api-key", "", "PizzaPi API key (default: PIZZAPI_API_KEY env)")
	sessionID := flag.String("session-id", "", "Session ID to watch (optional — if empty, shows session list)")
	flag.Parse()

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
	if url == "" {
		url = "http://localhost:7492"
	}

	app := tui.New(url, key, *sessionID)
	p := tea.NewProgram(app, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "error running TUI: %v\n", err)
		os.Exit(1)
	}
}
