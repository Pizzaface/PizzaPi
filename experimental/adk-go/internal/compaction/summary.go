package compaction

import (
	"context"
	"fmt"
	"strings"
)

// Message is a minimal conversation message used for summarisation.
type Message struct {
	Role    string
	Content string
}

// SummaryRequest describes what needs summarising.
type SummaryRequest struct {
	// Messages is the full conversation history to be summarised.
	Messages []Message
	// SystemPrompt is included for context but is not itself summarised.
	SystemPrompt string
	// MaxSummaryTokens is the target upper bound on the summary size.
	// Implementations should make a best-effort to stay within this limit.
	MaxSummaryTokens int
}

// SummaryResult is the output of a summarisation run.
type SummaryResult struct {
	// Summary is the produced summary text.
	Summary string
	// TokensBefore is the estimated token count before compaction.
	TokensBefore int
	// TokensAfter is the estimated token count of the resulting summary.
	TokensAfter int
	// MessagesRemoved is the number of messages that were dropped.
	MessagesRemoved int
	// Generation is the compaction generation counter at the time of this run.
	Generation int
}

// Summarizer produces compaction summaries.
type Summarizer interface {
	Summarize(ctx context.Context, req SummaryRequest) (*SummaryResult, error)
}

// naiveSummarizer is the built-in placeholder summariser.
type naiveSummarizer struct{}

// NewNaiveSummarizer returns a [Summarizer] that truncates older messages and
// prepends a header noting what was removed.
//
// This is a placeholder until an LLM-backed summariser is wired up. It keeps
// as many recent messages as fit within MaxSummaryTokens (using the 4
// chars-per-token heuristic) and replaces the dropped prefix with a short
// explanatory header.
func NewNaiveSummarizer() Summarizer {
	return &naiveSummarizer{}
}

// Summarize implements [Summarizer].
func (s *naiveSummarizer) Summarize(_ context.Context, req SummaryRequest) (*SummaryResult, error) {
	messages := req.Messages
	tokensBefore := EstimateTokens(messages)

	maxTokens := req.MaxSummaryTokens
	if maxTokens <= 0 {
		// Default: keep approximately half of what we had.
		maxTokens = tokensBefore / 2
		if maxTokens < 512 {
			maxTokens = 512
		}
	}

	// Walk from the end, accumulating messages until we approach the budget.
	kept := 0
	budget := maxTokens
	for i := len(messages) - 1; i >= 0; i-- {
		cost := 4 + len(messages[i].Content)/4
		if budget-cost < 0 && kept > 0 {
			break
		}
		budget -= cost
		kept++
	}

	removed := len(messages) - kept
	retained := messages[len(messages)-kept:]

	// Build the header.
	var sb strings.Builder
	if removed > 0 {
		fmt.Fprintf(&sb, "[Compaction: %d earlier message(s) were summarised and removed to fit the context window.]\n", removed)
	} else {
		sb.WriteString("[Compaction: no messages were removed; context fits within the token budget.]\n")
	}
	summary := sb.String()

	// Estimate tokens after: header + retained messages.
	afterMessages := make([]Message, 0, len(retained)+1)
	afterMessages = append(afterMessages, Message{Role: "system", Content: summary})
	afterMessages = append(afterMessages, retained...)
	tokensAfter := EstimateTokens(afterMessages)

	return &SummaryResult{
		Summary:         summary,
		TokensBefore:    tokensBefore,
		TokensAfter:     tokensAfter,
		MessagesRemoved: removed,
	}, nil
}
