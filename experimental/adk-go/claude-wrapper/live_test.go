package claudewrapper

import (
	"os"
	"strings"
	"testing"
)

// runLiveFile parses a captured NDJSON file through the parser and adapter,
// failing the test on any ParseError or UnknownEvent.
func runLiveFile(t *testing.T, path string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("skipping: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	t.Logf("Parsing %d NDJSON lines from %s", len(lines), path)

	adapter := NewAdapter()
	var totalRelayEvents, unknowns, errors int

	for i, line := range lines {
		ev := ParseLine([]byte(line))

		switch ev.(type) {
		case *ParseError:
			pe := ev.(*ParseError)
			errors++
			t.Errorf("line %d: ParseError: %s (line: %.100s)", i, pe.Message, pe.Line)
		case *UnknownEvent:
			ue := ev.(*UnknownEvent)
			unknowns++
			t.Errorf("line %d: UnknownEvent type=%q — parser needs update", i, ue.RawType)
		default:
			t.Logf("line %d: %s ✓", i, ev.EventType())
		}

		relayEvents := adapter.HandleEvent(ev)
		for _, re := range relayEvents {
			totalRelayEvents++
			reType, _ := re["type"].(string)
			t.Logf("  → relay event: %s", reType)
		}
	}

	t.Logf("\nSummary: %d input → %d relay events, %d unknowns, %d errors",
		len(lines), totalRelayEvents, unknowns, errors)
}

// TestLiveCLIOutput — simple text + tool use sessions.
func TestLiveCLIOutput(t *testing.T) {
	runLiveFile(t, "/tmp/claude-all.jsonl")
}

// TestLiveCLIPartialMessages — streaming with --include-partial-messages.
func TestLiveCLIPartialMessages(t *testing.T) {
	runLiveFile(t, "/tmp/claude-partial.jsonl")
}

// TestLiveCLIThinking — extended thinking blocks (sonnet model).
func TestLiveCLIThinking(t *testing.T) {
	runLiveFile(t, "/tmp/claude-thinking.jsonl")
}

// TestLiveCLIInteractive — TodoWrite, AskUserQuestion, EnterPlanMode tool calls.
func TestLiveCLIInteractive(t *testing.T) {
	runLiveFile(t, "/tmp/claude-interactive.jsonl")
}

// TestLiveCLIEverything — all captures combined (comprehensive coverage).
func TestLiveCLIEverything(t *testing.T) {
	runLiveFile(t, "/tmp/claude-everything.jsonl")
}
