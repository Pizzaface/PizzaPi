package runner

import (
	"log"

	claudecli "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/providers/claudecli"
	guardrails "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/guardrails"
)

// NewTestClaudeCLIProvider creates a ClaudeCLIProvider wired for unit testing:
//   - No real subprocess; stdin writes go to stdinBuf.
//   - guardEnv and stdinWriter are injected directly.
func NewTestClaudeCLIProvider(env guardrails.EvalEnv, stdinBuf *[][]byte) *ClaudeCLIProvider {
	p := &ClaudeCLIProvider{
		adapter:  claudecli.NewAdapter(),
		logger:   log.Default(),
		events:   make(chan RelayEvent, 32),
		done:     make(chan struct{}),
		guardEnv: env,
	}
	p.stdinWriter = func(b []byte) error {
		*stdinBuf = append(*stdinBuf, append([]byte(nil), b...))
		return nil
	}
	return p
}

// RunBridge runs bridge() synchronously with a slice of pre-built events
// and returns all relay events that were emitted.
func RunBridge(p *ClaudeCLIProvider, rawEvents []claudecli.ClaudeEvent) []RelayEvent {
	ch := make(chan claudecli.ClaudeEvent, len(rawEvents))
	for _, ev := range rawEvents {
		ch <- ev
	}
	close(ch)

	p.bridge(ch)

	var out []RelayEvent
	for ev := range p.events {
		out = append(out, ev)
	}
	return out
}
