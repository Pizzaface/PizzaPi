package compaction

import (
	"context"
	"strings"
	"testing"
)

func makeMessages(n int) []Message {
	msgs := make([]Message, n)
	for i := range msgs {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		msgs[i] = Message{Role: role, Content: strings.Repeat("word ", 50)}
	}
	return msgs
}

func TestNaiveSummarizer_EmptyInput(t *testing.T) {
	s := NewNaiveSummarizer()
	result, err := s.Summarize(context.Background(), SummaryRequest{
		Messages:         []Message{},
		MaxSummaryTokens: 500,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.MessagesRemoved != 0 {
		t.Errorf("empty input: MessagesRemoved = %d, want 0", result.MessagesRemoved)
	}
}

func TestNaiveSummarizer_FitsWithinBudget(t *testing.T) {
	// Very small conversation that fits entirely in budget.
	msgs := makeMessages(2)
	s := NewNaiveSummarizer()
	result, err := s.Summarize(context.Background(), SummaryRequest{
		Messages:         msgs,
		MaxSummaryTokens: 100_000, // enormous budget
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.MessagesRemoved != 0 {
		t.Errorf("no removal expected when budget is ample, got MessagesRemoved=%d", result.MessagesRemoved)
	}
}

func TestNaiveSummarizer_TruncatesOldMessages(t *testing.T) {
	// 20 messages, each ~50 words ≈ 250 chars ≈ 62 tokens.
	// Total ≈ 1240 tokens. Set budget to 400 so ~6–7 messages fit.
	msgs := makeMessages(20)
	s := NewNaiveSummarizer()
	result, err := s.Summarize(context.Background(), SummaryRequest{
		Messages:         msgs,
		MaxSummaryTokens: 400,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.MessagesRemoved <= 0 {
		t.Errorf("expected older messages to be removed, got MessagesRemoved=%d", result.MessagesRemoved)
	}
	if result.MessagesRemoved >= len(msgs) {
		t.Errorf("should retain at least one message; MessagesRemoved=%d out of %d", result.MessagesRemoved, len(msgs))
	}
}

func TestNaiveSummarizer_PreservesRecentMessages(t *testing.T) {
	// The naive summariser keeps the MOST RECENT messages, so removed < total.
	msgs := makeMessages(20)
	s := NewNaiveSummarizer()
	result, err := s.Summarize(context.Background(), SummaryRequest{
		Messages:         msgs,
		MaxSummaryTokens: 400,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	kept := len(msgs) - result.MessagesRemoved
	if kept <= 0 {
		t.Errorf("expected at least one message retained, kept=%d", kept)
	}
	// Tokens after should be less than tokens before.
	if result.TokensAfter >= result.TokensBefore {
		t.Errorf("TokensAfter (%d) should be < TokensBefore (%d)", result.TokensAfter, result.TokensBefore)
	}
}

func TestNaiveSummarizer_HeaderContainsRemovedCount(t *testing.T) {
	msgs := makeMessages(20)
	s := NewNaiveSummarizer()
	result, err := s.Summarize(context.Background(), SummaryRequest{
		Messages:         msgs,
		MaxSummaryTokens: 400,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.MessagesRemoved > 0 {
		countStr := itoa(result.MessagesRemoved)
		if !strings.Contains(result.Summary, countStr) {
			t.Errorf("header %q should mention removed count %s", result.Summary, countStr)
		}
		if !strings.Contains(result.Summary, "Compaction") {
			t.Errorf("header %q should contain 'Compaction'", result.Summary)
		}
	}
}

func TestNaiveSummarizer_DefaultBudgetWhenZero(t *testing.T) {
	// MaxSummaryTokens=0 should trigger the default (half of input, min 512).
	msgs := makeMessages(30)
	s := NewNaiveSummarizer()
	result, err := s.Summarize(context.Background(), SummaryRequest{
		Messages:         msgs,
		MaxSummaryTokens: 0,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
}

func TestNaiveSummarizer_GenerationPassthrough(t *testing.T) {
	// Generation is set by the executor, not the summariser.
	// The summariser returns generation=0; executor sets it afterwards.
	s := NewNaiveSummarizer()
	result, err := s.Summarize(context.Background(), SummaryRequest{
		Messages:         makeMessages(4),
		MaxSummaryTokens: 10_000,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Summariser itself always produces generation=0; the executor stamps it.
	if result.Generation != 0 {
		t.Errorf("Summarizer should return generation=0 (executor stamps it), got %d", result.Generation)
	}
}
