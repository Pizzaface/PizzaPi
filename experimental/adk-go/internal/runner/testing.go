package runner

import (
	"encoding/json"
	"log"

	guardrails "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/guardrails"
	claudecli "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/providers/claudecli"
)

// NewTestClaudeCLIProvider creates a ClaudeCLIProvider wired for unit testing.
// It no longer exercises provider-owned orchestration directly; instead it
// returns a lightweight provider value so existing tests can share helpers.
func NewTestClaudeCLIProvider(env guardrails.EvalEnv, stdinBuf *[][]byte) *ClaudeCLIProvider {
	_ = env
	_ = stdinBuf
	return &ClaudeCLIProvider{logger: log.Default()}
}

// RunBridge runs the Claude-on-ADK session bridge synchronously with a slice of
// pre-built Claude events and returns all relay events that were emitted.
func RunBridge(_ *ClaudeCLIProvider, env guardrails.EvalEnv, stdinBuf *[][]byte, rawEvents []claudecli.ClaudeEvent) []RelayEvent {
	bridge := claudecli.NewSessionBridge(claudecli.SessionBridgeConfig{
		GuardEnv: env,
		Logger:   log.Default(),
		WriteStdin: func(b []byte) error {
			*stdinBuf = append(*stdinBuf, append([]byte(nil), b...))
			return nil
		},
	})
	relayAdapter := claudecli.NewRuntimeRelayAdapter()

	var out []RelayEvent
	for _, ev := range rawEvents {
		for _, translated := range bridge.Translate("test-invocation", ev) {
			for _, relayEvent := range relayAdapter.HandleEvent(translated) {
				out = append(out, relayEvent)
			}
		}
	}
	return out
}

func marshalToolArgs(args map[string]any) json.RawMessage {
	raw, _ := json.Marshal(args)
	return raw
}
