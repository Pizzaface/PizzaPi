package claudewrapper

import (
	"os"
	"strings"
	"testing"
)

// TestLiveCLIOutput feeds real Claude CLI NDJSON output through the parser and adapter.
// Run with: go test -v -run TestLiveCLI ./...
// Requires /tmp/claude-all.jsonl to exist (captured from real claude CLI).
func TestLiveCLIOutput(t *testing.T) {
	data, err := os.ReadFile("/tmp/claude-all.jsonl")
	if err != nil {
		t.Skipf("skipping live test: %v (run claude CLI to capture /tmp/claude-all.jsonl)", err)
	}

	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	t.Logf("Parsing %d NDJSON lines from live Claude CLI output", len(lines))

	adapter := NewAdapter()
	var totalRelayEvents int

	for i, line := range lines {
		ev := ParseLine([]byte(line))
		evType := ev.EventType()

		switch ev.(type) {
		case *ParseError:
			pe := ev.(*ParseError)
			t.Errorf("line %d: ParseError: %s (line content: %.100s)", i, pe.Message, pe.Line)
		case *UnknownEvent:
			ue := ev.(*UnknownEvent)
			t.Logf("line %d: UnknownEvent type=%q (raw: %.200s...)", i, ue.RawType, string(ue.Raw))
		default:
			t.Logf("line %d: %s ✓", i, evType)
		}

		relayEvents := adapter.HandleEvent(ev)
		for _, re := range relayEvents {
			totalRelayEvents++
			reType, _ := re["type"].(string)
			t.Logf("  → relay event: %s", reType)
		}
	}

	t.Logf("\nSummary: %d input lines → %d relay events", len(lines), totalRelayEvents)
}
