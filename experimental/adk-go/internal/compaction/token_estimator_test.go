package compaction

import (
	"strings"
	"testing"
)

func TestEstimateTokens_Empty(t *testing.T) {
	got := EstimateTokens(nil)
	if got != 0 {
		t.Errorf("EstimateTokens(nil) = %d, want 0", got)
	}
	got = EstimateTokens([]Message{})
	if got != 0 {
		t.Errorf("EstimateTokens([]) = %d, want 0", got)
	}
}

func TestEstimateTokens_SingleMessage(t *testing.T) {
	msg := Message{Role: "user", Content: strings.Repeat("a", 400)}
	got := EstimateTokens([]Message{msg})
	// 400 chars / 4 = 100 content tokens + 4 role overhead = 104
	want := 104
	if got != want {
		t.Errorf("EstimateTokens single message = %d, want %d", got, want)
	}
}

func TestEstimateTokens_MultipleMessages(t *testing.T) {
	messages := []Message{
		{Role: "user", Content: strings.Repeat("x", 400)},      // 100 + 4 = 104
		{Role: "assistant", Content: strings.Repeat("y", 800)}, // 200 + 4 = 204
	}
	got := EstimateTokens(messages)
	want := 308
	if got != want {
		t.Errorf("EstimateTokens two messages = %d, want %d", got, want)
	}
}

func TestEstimateTokens_GrowsWithContent(t *testing.T) {
	small := []Message{{Role: "user", Content: "hi"}}
	large := []Message{{Role: "user", Content: strings.Repeat("a", 10_000)}}
	if EstimateTokens(small) >= EstimateTokens(large) {
		t.Error("EstimateTokens should return more tokens for larger content")
	}
}

func TestEstimateTokens_ReasonableRange(t *testing.T) {
	// A 1000-character message should produce between 200 and 300 tokens.
	msg := Message{Role: "user", Content: strings.Repeat("a", 1000)}
	got := EstimateTokens([]Message{msg})
	if got < 200 || got > 300 {
		t.Errorf("EstimateTokens(1000 chars) = %d, expected in [200, 300]", got)
	}
}
