package compaction

import (
	"testing"
)

func TestDefaultPolicy(t *testing.T) {
	p := DefaultPolicy()
	if p.SoftThresholdTokens <= 0 {
		t.Error("DefaultPolicy: SoftThresholdTokens must be positive")
	}
	if p.HardThresholdTokens <= p.SoftThresholdTokens {
		t.Errorf("DefaultPolicy: HardThreshold (%d) must be > SoftThreshold (%d)",
			p.HardThresholdTokens, p.SoftThresholdTokens)
	}
	if p.MinTurnsBeforeCompact <= 0 {
		t.Error("DefaultPolicy: MinTurnsBeforeCompact must be positive")
	}
}

func TestPolicy_BelowSoftThreshold(t *testing.T) {
	p := Policy{
		SoftThresholdTokens:   1000,
		HardThresholdTokens:   2000,
		MinTurnsBeforeCompact: 3,
	}
	state := ContextState{
		EstimatedTokens:   500,
		TurnCount:         10,
		TurnsSinceCompact: 10,
	}
	d := p.ShouldCompact(state)
	if d.ShouldCompact {
		t.Errorf("expected no compaction below soft threshold, reason: %s", d.Reason)
	}
	if d.IsHard {
		t.Error("expected IsHard=false below thresholds")
	}
}

func TestPolicy_AtSoftThreshold(t *testing.T) {
	p := Policy{
		SoftThresholdTokens:   1000,
		HardThresholdTokens:   2000,
		MinTurnsBeforeCompact: 3,
	}
	state := ContextState{
		EstimatedTokens:   1000,
		TurnCount:         10,
		TurnsSinceCompact: 10,
	}
	d := p.ShouldCompact(state)
	if !d.ShouldCompact {
		t.Errorf("expected compaction at soft threshold, reason: %s", d.Reason)
	}
	if d.IsHard {
		t.Error("expected IsHard=false at soft threshold")
	}
}

func TestPolicy_AboveSoftThreshold(t *testing.T) {
	p := Policy{
		SoftThresholdTokens:   1000,
		HardThresholdTokens:   2000,
		MinTurnsBeforeCompact: 3,
	}
	state := ContextState{
		EstimatedTokens:   1500,
		TurnCount:         10,
		TurnsSinceCompact: 10,
	}
	d := p.ShouldCompact(state)
	if !d.ShouldCompact {
		t.Errorf("expected compaction above soft threshold, reason: %s", d.Reason)
	}
	if d.IsHard {
		t.Error("expected IsHard=false between thresholds")
	}
}

func TestPolicy_AtHardThreshold(t *testing.T) {
	p := Policy{
		SoftThresholdTokens:   1000,
		HardThresholdTokens:   2000,
		MinTurnsBeforeCompact: 3,
	}
	state := ContextState{
		EstimatedTokens:   2000,
		TurnCount:         10,
		TurnsSinceCompact: 10,
	}
	d := p.ShouldCompact(state)
	if !d.ShouldCompact {
		t.Errorf("expected compaction at hard threshold, reason: %s", d.Reason)
	}
	if !d.IsHard {
		t.Error("expected IsHard=true at hard threshold")
	}
}

func TestPolicy_AboveHardThreshold(t *testing.T) {
	p := Policy{
		SoftThresholdTokens:   1000,
		HardThresholdTokens:   2000,
		MinTurnsBeforeCompact: 3,
	}
	state := ContextState{
		EstimatedTokens:   9999,
		TurnCount:         10,
		TurnsSinceCompact: 10,
	}
	d := p.ShouldCompact(state)
	if !d.ShouldCompact {
		t.Errorf("expected compaction above hard threshold, reason: %s", d.Reason)
	}
	if !d.IsHard {
		t.Error("expected IsHard=true above hard threshold")
	}
}

func TestPolicy_MinTurnsNotMet(t *testing.T) {
	p := Policy{
		SoftThresholdTokens:   100,
		HardThresholdTokens:   200,
		MinTurnsBeforeCompact: 5,
	}
	// Tokens above soft threshold but turns below min.
	state := ContextState{
		EstimatedTokens:   150,
		TurnCount:         3,
		TurnsSinceCompact: 3,
	}
	d := p.ShouldCompact(state)
	if d.ShouldCompact {
		t.Errorf("expected no compaction when turns < MinTurnsBeforeCompact, reason: %s", d.Reason)
	}
}

func TestPolicy_MinTurnsExactlyMet(t *testing.T) {
	p := Policy{
		SoftThresholdTokens:   100,
		HardThresholdTokens:   200,
		MinTurnsBeforeCompact: 5,
	}
	state := ContextState{
		EstimatedTokens:   150,
		TurnCount:         5, // exactly the minimum
		TurnsSinceCompact: 5,
	}
	d := p.ShouldCompact(state)
	if !d.ShouldCompact {
		t.Errorf("expected compaction when turns == MinTurnsBeforeCompact, reason: %s", d.Reason)
	}
}

func TestPolicy_ReasonIsNonEmpty(t *testing.T) {
	p := DefaultPolicy()
	cases := []ContextState{
		{EstimatedTokens: 0, TurnCount: 100},
		{EstimatedTokens: p.SoftThresholdTokens, TurnCount: 100},
		{EstimatedTokens: p.HardThresholdTokens, TurnCount: 100},
		{EstimatedTokens: p.SoftThresholdTokens + 1, TurnCount: 1},
	}
	for _, state := range cases {
		d := p.ShouldCompact(state)
		if d.Reason == "" {
			t.Errorf("ShouldCompact returned empty Reason for state %+v", state)
		}
	}
}

func TestPolicy_HardThresholdBeforeSoft(t *testing.T) {
	// When tokens exceed both thresholds, hard wins.
	p := Policy{
		SoftThresholdTokens:   100,
		HardThresholdTokens:   200,
		MinTurnsBeforeCompact: 1,
	}
	state := ContextState{EstimatedTokens: 300, TurnCount: 10}
	d := p.ShouldCompact(state)
	if !d.IsHard {
		t.Error("expected hard decision when tokens exceed hard threshold")
	}
}
