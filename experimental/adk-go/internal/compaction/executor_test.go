package compaction

import (
	"context"
	"errors"
	"testing"
)

// smallPolicy returns a policy that triggers easily so tests don't need large
// message sets.
func smallPolicy() Policy {
	return Policy{
		SoftThresholdTokens:   10,
		HardThresholdTokens:   500,
		MinTurnsBeforeCompact: 1,
	}
}

func hardPolicy() Policy {
	return Policy{
		SoftThresholdTokens:   10,
		HardThresholdTokens:   10, // same as soft → always hard
		MinTurnsBeforeCompact: 1,
	}
}

func stateAboveSoft() ContextState {
	return ContextState{
		EstimatedTokens:   100,
		TurnCount:         10,
		TurnsSinceCompact: 10,
	}
}

func stateAboveHard() ContextState {
	return ContextState{
		EstimatedTokens:   600,
		TurnCount:         10,
		TurnsSinceCompact: 10,
	}
}

func stateBelowThreshold() ContextState {
	return ContextState{
		EstimatedTokens:   1,
		TurnCount:         10,
		TurnsSinceCompact: 10,
	}
}

// --- hook ordering -----------------------------------------------------------

func TestExecutor_HookOrder_SoftCompaction(t *testing.T) {
	var order []string
	hooks := CompactionHooks{
		OnBeforeCompact: func(_ ContextState) bool {
			order = append(order, "before")
			return true
		},
		OnCompactStarted: func(_ int) {
			order = append(order, "started")
		},
		OnCompactComplete: func(_ *CompactionResult) {
			order = append(order, "complete")
		},
	}

	e := NewExecutor(smallPolicy(), NewNaiveSummarizer(), hooks)
	msgs := makeMessages(4)
	result, err := e.TryCompact(context.Background(), stateAboveSoft(), msgs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("expected result, got nil")
	}
	if result.WasCancelled {
		t.Error("expected compaction to proceed")
	}

	wantOrder := []string{"before", "started", "complete"}
	if len(order) != len(wantOrder) {
		t.Fatalf("hook order: got %v, want %v", order, wantOrder)
	}
	for i, v := range wantOrder {
		if order[i] != v {
			t.Errorf("hook order[%d]: got %q, want %q", i, order[i], v)
		}
	}
}

// --- soft cancellation -------------------------------------------------------

func TestExecutor_SoftCancel(t *testing.T) {
	var completeCalled bool
	hooks := CompactionHooks{
		OnBeforeCompact: func(_ ContextState) bool {
			return false // cancel
		},
		OnCompactComplete: func(r *CompactionResult) {
			completeCalled = true
			if !r.WasCancelled {
				t.Error("OnCompactComplete: expected WasCancelled=true")
			}
		},
	}

	e := NewExecutor(smallPolicy(), NewNaiveSummarizer(), hooks)
	result, err := e.TryCompact(context.Background(), stateAboveSoft(), makeMessages(4))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("expected result, got nil")
	}
	if !result.WasCancelled {
		t.Error("expected WasCancelled=true after hook cancellation")
	}
	if !completeCalled {
		t.Error("OnCompactComplete should be called even on cancellation")
	}
}

// --- hard threshold cannot be cancelled --------------------------------------

func TestExecutor_HardThreshold_NotCancellable(t *testing.T) {
	p := Policy{
		SoftThresholdTokens:   10,
		HardThresholdTokens:   50,
		MinTurnsBeforeCompact: 1,
	}
	state := ContextState{EstimatedTokens: 100, TurnCount: 5}

	hooks := CompactionHooks{
		OnBeforeCompact: func(_ ContextState) bool {
			return false // attempt cancellation
		},
	}

	e := NewExecutor(p, NewNaiveSummarizer(), hooks)
	result, err := e.TryCompact(context.Background(), state, makeMessages(4))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("expected result, got nil")
	}
	if result.WasCancelled {
		t.Error("hard compaction must not be cancellable")
	}
}

// --- policy below threshold returns nil --------------------------------------

func TestExecutor_TryCompact_BelowThreshold(t *testing.T) {
	e := NewExecutor(smallPolicy(), NewNaiveSummarizer(), CompactionHooks{})
	result, err := e.TryCompact(context.Background(), stateBelowThreshold(), makeMessages(4))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil {
		t.Errorf("expected nil result when below threshold, got %+v", result)
	}
}

// --- ForceCompact always runs ------------------------------------------------

func TestExecutor_ForceCompact_AlwaysRuns(t *testing.T) {
	e := NewExecutor(smallPolicy(), NewNaiveSummarizer(), CompactionHooks{})
	// Force compaction even though state is below threshold.
	result, err := e.ForceCompact(context.Background(), makeMessages(4))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("ForceCompact should always return a result")
	}
	if result.WasCancelled {
		t.Error("ForceCompact result should not be cancelled")
	}
}

func TestExecutor_ForceCompact_HooksCalledInOrder(t *testing.T) {
	var order []string
	hooks := CompactionHooks{
		OnBeforeCompact: func(_ ContextState) bool {
			order = append(order, "before")
			return false // cancellation ignored for force
		},
		OnCompactStarted: func(_ int) {
			order = append(order, "started")
		},
		OnCompactComplete: func(_ *CompactionResult) {
			order = append(order, "complete")
		},
	}
	e := NewExecutor(smallPolicy(), NewNaiveSummarizer(), hooks)
	_, err := e.ForceCompact(context.Background(), makeMessages(4))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// before is called but cancellation is ignored; started and complete follow.
	want := []string{"before", "started", "complete"}
	if len(order) != len(want) {
		t.Fatalf("hook order: got %v, want %v", order, want)
	}
	for i, v := range want {
		if order[i] != v {
			t.Errorf("hook order[%d]: got %q, want %q", i, order[i], v)
		}
	}
}

// --- generation counter monotonicity ----------------------------------------

func TestExecutor_GenerationMonotonic(t *testing.T) {
	e := NewExecutor(smallPolicy(), NewNaiveSummarizer(), CompactionHooks{})
	msgs := makeMessages(4)
	state := stateAboveSoft()

	var gens []int
	for i := 0; i < 5; i++ {
		r, err := e.TryCompact(context.Background(), state, msgs)
		if err != nil {
			t.Fatalf("run %d: unexpected error: %v", i, err)
		}
		if r == nil {
			t.Fatalf("run %d: expected result", i)
		}
		gens = append(gens, r.Generation)
	}
	for i := 1; i < len(gens); i++ {
		if gens[i] <= gens[i-1] {
			t.Errorf("generation not monotonically increasing: %v", gens)
		}
	}
}

func TestExecutor_ForceCompact_GenerationMonotonic(t *testing.T) {
	e := NewExecutor(smallPolicy(), NewNaiveSummarizer(), CompactionHooks{})
	msgs := makeMessages(4)

	prev := 0
	for i := 0; i < 3; i++ {
		r, err := e.ForceCompact(context.Background(), msgs)
		if err != nil {
			t.Fatalf("run %d: unexpected error: %v", i, err)
		}
		if r.Generation <= prev {
			t.Errorf("run %d: generation %d not > previous %d", i, r.Generation, prev)
		}
		prev = r.Generation
	}
}

// --- summariser error propagation -------------------------------------------

type errSummarizer struct{}

func (errSummarizer) Summarize(_ context.Context, _ SummaryRequest) (*SummaryResult, error) {
	return nil, errors.New("summariser failure")
}

func TestExecutor_SummarizerError_PropagatesWithGeneration(t *testing.T) {
	hooks := CompactionHooks{}
	e := NewExecutor(smallPolicy(), errSummarizer{}, hooks)
	result, err := e.ForceCompact(context.Background(), makeMessages(4))
	if err == nil {
		t.Fatal("expected error from summariser")
	}
	if result == nil {
		t.Fatal("result should be non-nil even on error")
	}
	if result.Error == nil {
		t.Error("result.Error should be set")
	}
	if result.Generation == 0 {
		t.Error("generation should have been incremented even on error")
	}
}

// --- nil hooks are safe ------------------------------------------------------

func TestExecutor_NilHooks_Safe(t *testing.T) {
	e := NewExecutor(smallPolicy(), NewNaiveSummarizer(), CompactionHooks{})
	_, err := e.TryCompact(context.Background(), stateAboveSoft(), makeMessages(4))
	if err != nil {
		t.Fatalf("nil hooks should not panic or error: %v", err)
	}
}

// --- result carries correct generation --------------------------------------

func TestExecutor_ResultGenerationMatchesInternal(t *testing.T) {
	e := NewExecutor(smallPolicy(), NewNaiveSummarizer(), CompactionHooks{})
	msgs := makeMessages(4)
	state := stateAboveSoft()

	r1, _ := e.TryCompact(context.Background(), state, msgs)
	r2, _ := e.TryCompact(context.Background(), state, msgs)

	if r1 == nil || r2 == nil {
		t.Fatal("expected non-nil results")
	}
	if r1.Generation != 1 {
		t.Errorf("first generation should be 1, got %d", r1.Generation)
	}
	if r2.Generation != 2 {
		t.Errorf("second generation should be 2, got %d", r2.Generation)
	}
	// Summary.Generation should match outer result generation.
	if r1.Summary.Generation != r1.Generation {
		t.Errorf("Summary.Generation (%d) != Generation (%d)", r1.Summary.Generation, r1.Generation)
	}
}
