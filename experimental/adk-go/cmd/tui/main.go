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
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"runtime"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/auth"
	oaiprovider "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/providers/openai"
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
	loginFlag := flag.Bool("login", false, "Run OAuth login flow for the selected provider")
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

	// Handle OAuth login for providers that support it
	if *loginFlag || (*provider == "openai" && needsOpenAILogin()) {
		if *provider == "openai" {
			if err := runOpenAILogin(); err != nil {
				fmt.Fprintf(os.Stderr, "Login failed: %v\n", err)
				os.Exit(1)
			}
			if *loginFlag {
				fmt.Println("Login successful!")
				os.Exit(0)
			}
		} else if *loginFlag {
			fmt.Fprintf(os.Stderr, "OAuth login not supported for provider %q\n", *provider)
			os.Exit(1)
		}
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

// needsOpenAILogin checks if OpenAI OAuth or API key is configured.
func needsOpenAILogin() bool {
	storage := auth.NewStorage("")
	oaiprovider.RegisterOAuthRefresher(storage)
	p := oaiprovider.NewProvider(storage, nil)
	return p.NeedsLogin()
}

// runOpenAILogin executes the interactive OAuth flow for OpenAI.
func runOpenAILogin() error {
	storage := auth.NewStorage("")

	fmt.Println("🔑 Logging in to OpenAI (ChatGPT Plus/Pro)...")
	fmt.Println()

	cred, err := auth.LoginOpenAI(context.Background(), auth.LoginCallbacks{
		OnAuth: func(url string, instructions string) {
			fmt.Printf("Opening browser: %s\n", url)
			fmt.Printf("  %s\n\n", instructions)
			openBrowser(url)
		},
		OnProgress: func(message string) {
			fmt.Printf("  %s\n", message)
		},
	})
	if err != nil {
		return err
	}

	// Store the credential
	if err := storage.Set(oaiprovider.OAuthProviderID, cred); err != nil {
		return fmt.Errorf("save credentials: %w", err)
	}

	fmt.Println("✅ Credentials saved to ~/.pizzapi/auth.json")
	return nil
}

// openBrowser tries to open a URL in the default browser.
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		return
	}
	cmd.Start()
}
