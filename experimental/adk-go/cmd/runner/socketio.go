// Package main re-exports the Socket.IO client from internal/relay.
// All logic lives in internal/relay; these are convenience aliases so the
// rest of cmd/runner doesn't need to change every import line.
package main

import "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/relay"

// Type aliases — the runner code keeps using SIOClient/SIOClientConfig,
// but the real implementation is in internal/relay.
type SIOClient = relay.Client
type SIOClientConfig = relay.ClientConfig

// NewSIOClient creates a new Socket.IO client.
var NewSIOClient = relay.NewClient
