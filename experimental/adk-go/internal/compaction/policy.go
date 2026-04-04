// Package compaction implements context-window compaction for long-running
// sessions. It decides when to compact, generates summaries, and orchestrates
// the compaction lifecycle.
package compaction

// Policy decides when compaction should run.
type Policy struct {
	// SoftThresholdTokens triggers proactive compaction when the estimated
	// token count exceeds this value.
	SoftThresholdTokens int
	// HardThresholdTokens forces compaction unconditionally; cannot be
	// cancelled by the OnBeforeCompact hook.
	HardThresholdTokens int
	// MinTurnsBeforeCompact suppresses compaction until at least this many
	// turns have elapsed (avoids thrashing at session start).
	MinTurnsBeforeCompact int
}

// DefaultPolicy returns sensible defaults suitable for most sessions.
func DefaultPolicy() Policy {
	return Policy{
		SoftThresholdTokens:   80_000,
		HardThresholdTokens:   150_000,
		MinTurnsBeforeCompact: 5,
	}
}

// ContextState captures the runtime information the policy needs to decide
// whether compaction should run.
type ContextState struct {
	// EstimatedTokens is the current estimated token usage of the conversation.
	EstimatedTokens int
	// TurnCount is the total number of turns in the session so far.
	TurnCount int
	// LastCompactGeneration is the generation counter at the last compaction.
	// Zero means compaction has never run.
	LastCompactGeneration int
	// TurnsSinceCompact is how many turns have elapsed since the last
	// compaction. If compaction has never run, this should equal TurnCount.
	TurnsSinceCompact int
}

// CompactDecision is the output of a policy evaluation.
type CompactDecision struct {
	// ShouldCompact is true when the policy recommends running compaction.
	ShouldCompact bool
	// Reason explains why compaction was (or was not) recommended.
	Reason string
	// IsHard is true when the hard threshold was hit; the compaction cannot be
	// cancelled by the OnBeforeCompact hook.
	IsHard bool
}

// ShouldCompact evaluates whether compaction should run given current state.
func (p Policy) ShouldCompact(state ContextState) CompactDecision {
	if state.TurnCount < p.MinTurnsBeforeCompact {
		return CompactDecision{
			ShouldCompact: false,
			Reason: "turn count too low: " +
				itoa(state.TurnCount) + " < " + itoa(p.MinTurnsBeforeCompact),
		}
	}

	if p.HardThresholdTokens > 0 && state.EstimatedTokens >= p.HardThresholdTokens {
		return CompactDecision{
			ShouldCompact: true,
			IsHard:        true,
			Reason: "hard threshold reached: " +
				itoa(state.EstimatedTokens) + " >= " + itoa(p.HardThresholdTokens),
		}
	}

	if p.SoftThresholdTokens > 0 && state.EstimatedTokens >= p.SoftThresholdTokens {
		return CompactDecision{
			ShouldCompact: true,
			IsHard:        false,
			Reason: "soft threshold reached: " +
				itoa(state.EstimatedTokens) + " >= " + itoa(p.SoftThresholdTokens),
		}
	}

	return CompactDecision{
		ShouldCompact: false,
		Reason: "below threshold: " +
			itoa(state.EstimatedTokens) + " < " + itoa(p.SoftThresholdTokens),
	}
}

// itoa converts an int to its decimal string representation without importing
// strconv (keeps this file dependency-free).
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	buf := [20]byte{}
	pos := len(buf)
	for n > 0 {
		pos--
		buf[pos] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}
