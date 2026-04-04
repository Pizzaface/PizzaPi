package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	relayURL := flag.String("relay-url", "", "PizzaPi relay URL (default: PIZZAPI_RELAY_URL or http://localhost:7492)")
	runnerName := flag.String("runner-name", "", "Runner display name (default: hostname)")
	runnerID := flag.String("runner-id", "", "Runner ID (default: go-runner-<hostname>)")
	flag.Parse()

	url := *relayURL
	if url == "" {
		url = os.Getenv("PIZZAPI_RELAY_URL")
	}
	if url == "" {
		url = "http://localhost:7492"
	}
	if len(url) > 5 && url[:5] == "ws://" {
		url = "http://" + url[5:]
	} else if len(url) > 6 && url[:6] == "wss://" {
		url = "https://" + url[6:]
	}

	apiKey := os.Getenv("PIZZAPI_API_KEY")
	if apiKey == "" {
		apiKey = os.Getenv("PIZZAPI_API_TOKEN")
	}
	if apiKey == "" {
		fmt.Fprintln(os.Stderr, "error: PIZZAPI_API_KEY environment variable is required")
		os.Exit(1)
	}

	id := *runnerID
	if id == "" {
		hostname, _ := os.Hostname()
		id = "go-runner-" + hostname
	}

	runner := NewGoRunner(url, apiKey, id, *runnerName)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := runner.Run(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}
