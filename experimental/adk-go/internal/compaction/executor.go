package compaction

import (
	"context"
	"fmt"
)

// CompactionHooks are callbacks the runtime provides to observe and influence
// the compaction lifecycle.
type CompactionHooks struct {
	// OnBeforeCompact fires before compaction starts.
	// Return false to cancel; cancellation is only honoured for soft-threshold
	// compactions — hard-threshold compactions always proceed.
	OnBeforeCompact func(state ContextState) (proceed bool)

	// OnCompactStarted fires when compaction begins (useful for UI heartbeats).
	OnCompactStarted func(generation int)

	// OnCompactComplete fires after compaction has completed (or been
	// cancelled). The result is always non-nil; check result.WasCancelled and
	// result.Error for outcome details.
	OnCompactComplete func(result *CompactionResult)
}

// CompactionResult is the outcome of a full compaction run.
type CompactionResult struct {
	Summary      SummaryResult
	Generation   int
	WasCancelled bool
	Error        error
}

// Executor orchestrates the compaction lifecycle.
type Executor struct {
	Policy     Policy
	Summarizer Summarizer
	Hooks      CompactionHooks
	generation int // monotonic compaction counter, incremented on each run
}

// NewExecutor creates a new [Executor].
func NewExecutor(policy Policy, summarizer Summarizer, hooks CompactionHooks) *Executor {
	return &Executor{
		Policy:     policy,
		Summarizer: summarizer,
		Hooks:      hooks,
	}
}

// TryCompact evaluates the policy and runs compaction if the policy recommends
// it. Returns nil if compaction was not needed or was cancelled by the
// OnBeforeCompact hook.
func (e *Executor) TryCompact(ctx context.Context, state ContextState, messages []Message) (*CompactionResult, error) {
	decision := e.Policy.ShouldCompact(state)
	if !decision.ShouldCompact {
		return nil, nil
	}

	// Give the runtime a chance to cancel soft compactions.
	if !decision.IsHard && e.Hooks.OnBeforeCompact != nil {
		if !e.Hooks.OnBeforeCompact(state) {
			result := &CompactionResult{
				Generation:   e.generation,
				WasCancelled: true,
			}
			if e.Hooks.OnCompactComplete != nil {
				e.Hooks.OnCompactComplete(result)
			}
			return result, nil
		}
	}

	// Hard compactions call OnBeforeCompact for notification only (ignored).
	if decision.IsHard && e.Hooks.OnBeforeCompact != nil {
		e.Hooks.OnBeforeCompact(state) // result intentionally discarded
	}

	return e.runCompaction(ctx, messages)
}

// ForceCompact runs compaction unconditionally, bypassing policy checks.
// Use this to recover from context-overflow errors returned by the provider.
func (e *Executor) ForceCompact(ctx context.Context, messages []Message) (*CompactionResult, error) {
	// Notify hooks that we're about to compact (not cancellable).
	if e.Hooks.OnBeforeCompact != nil {
		e.Hooks.OnBeforeCompact(ContextState{EstimatedTokens: EstimateTokens(messages)})
	}
	return e.runCompaction(ctx, messages)
}

// runCompaction performs the actual summarisation and fires lifecycle hooks.
func (e *Executor) runCompaction(ctx context.Context, messages []Message) (*CompactionResult, error) {
	e.generation++
	gen := e.generation

	if e.Hooks.OnCompactStarted != nil {
		e.Hooks.OnCompactStarted(gen)
	}

	req := SummaryRequest{
		Messages: messages,
	}
	summary, err := e.Summarizer.Summarize(ctx, req)

	var result *CompactionResult
	if err != nil {
		result = &CompactionResult{
			Generation: gen,
			Error:      fmt.Errorf("compaction generation %d: %w", gen, err),
		}
	} else {
		summary.Generation = gen
		result = &CompactionResult{
			Summary:    *summary,
			Generation: gen,
		}
	}

	if e.Hooks.OnCompactComplete != nil {
		e.Hooks.OnCompactComplete(result)
	}

	if result.Error != nil {
		return result, result.Error
	}
	return result, nil
}
