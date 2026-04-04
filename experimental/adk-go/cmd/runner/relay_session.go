// Package main re-exports the relay session from internal/relay.
package main

import (
	"log"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/relay"
)

// RelaySession is a per-session /relay namespace connection.
type RelaySession = relay.Session

// NewRelaySession creates a relay session (not yet connected).
func NewRelaySession(relayURL, apiKey, sessionID, cwd string, logger *log.Logger) *RelaySession {
	return relay.NewSession(relayURL, apiKey, sessionID, cwd, logger)
}

// shortID returns the first 8 characters of s, or s itself if shorter.
func shortID(s string) string {
	return relay.ShortID(s)
}
