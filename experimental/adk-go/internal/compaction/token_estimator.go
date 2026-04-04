package compaction

// EstimateTokens gives a rough token count for a slice of conversation
// messages using the ~4 characters per token heuristic.
//
// This is a placeholder until a real tokenizer is integrated.
func EstimateTokens(messages []Message) int {
	total := 0
	for i := range messages {
		// Count role label overhead (~4 tokens) plus content characters.
		total += 4 + len(messages[i].Content)/4
	}
	return total
}
