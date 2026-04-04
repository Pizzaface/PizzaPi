package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/compaction"
	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/sessions"
)

// sessionCompaction tracks compaction-related state for a running session.
// It bridges the generic compaction package with the runner's relay/session
// lifecycle.
type sessionCompaction struct {
	executor *compaction.Executor
	store    sessions.SessionStore

	mu                   sync.Mutex
	messages             []compaction.Message // conversation history for token estimation
	turnCount            int
	lastCompactGen       int
	turnsSinceCompact    int
	isCompacting         bool
	pendingUserMessage   string // saved for reactive replay after overflow compaction
	sessionID            string
	cwd                  string
	logger               *log.Logger

	// emitEvent sends a relay event through the session's relay connection.
	emitEvent func(RelayEvent)
	// emitRunnerEvent sends a relay event through the runner's main connection.
	emitRunnerEvent func(RelayEvent)
}

// newSessionCompaction creates a sessionCompaction wired to emit relay events.
func newSessionCompaction(
	sessionID, cwd string,
	store sessions.SessionStore,
	logger *log.Logger,
	emitEvent func(RelayEvent),
	emitRunnerEvent func(RelayEvent),
) *sessionCompaction {
	sc := &sessionCompaction{
		sessionID:       sessionID,
		cwd:             cwd,
		store:           store,
		logger:          logger,
		emitEvent:       emitEvent,
		emitRunnerEvent: emitRunnerEvent,
	}

	hooks := compaction.CompactionHooks{
		OnBeforeCompact: func(state compaction.ContextState) bool {
			// Always allow compaction (no hook cancellation in Phase 1).
			return true
		},
		OnCompactStarted: func(generation int) {
			sc.mu.Lock()
			sc.isCompacting = true
			sc.mu.Unlock()

			sc.logger.Printf("session %s: compaction started (generation %d)",
				shortID(sessionID), generation)

			// Emit compact_started meta-event
			sc.emitEvent(RelayEvent{
				"type": "compact_started",
			})

			// Emit heartbeat with isCompacting: true
			hb := RelayEvent{
				"type":         "heartbeat",
				"active":       true,
				"isCompacting": true,
				"ts":           time.Now().UnixMilli(),
			}
			sc.emitEvent(hb)
			sc.emitRunnerEvent(hb)
		},
		OnCompactComplete: func(result *compaction.CompactionResult) {
			sc.mu.Lock()
			sc.isCompacting = false
			if result != nil && result.Error == nil && !result.WasCancelled {
				sc.lastCompactGen = result.Generation
				sc.turnsSinceCompact = 0
			}
			sc.mu.Unlock()

			if result != nil && result.Error != nil {
				sc.logger.Printf("session %s: compaction failed (generation %d): %v",
					shortID(sessionID), result.Generation, result.Error)
			} else if result != nil && result.WasCancelled {
				sc.logger.Printf("session %s: compaction cancelled (generation %d)",
					shortID(sessionID), result.Generation)
			} else if result != nil {
				sc.logger.Printf("session %s: compaction completed (generation %d): %d→%d tokens, %d messages removed",
					shortID(sessionID), result.Generation,
					result.Summary.TokensBefore, result.Summary.TokensAfter,
					result.Summary.MessagesRemoved)

				// Persist compaction event to session store
				sc.persistCompactionResult(result)

				// Emit compaction summary as a message_update so the UI shows it
				sc.emitCompactionSummaryMessage(result)
			}

			// Emit compact_ended meta-event
			sc.emitEvent(RelayEvent{
				"type": "compact_ended",
			})

			// Emit heartbeat with isCompacting: false
			hb := RelayEvent{
				"type":         "heartbeat",
				"active":       true,
				"isCompacting": false,
				"ts":           time.Now().UnixMilli(),
			}
			sc.emitEvent(hb)
			sc.emitRunnerEvent(hb)
		},
	}

	sc.executor = compaction.NewExecutor(
		compaction.DefaultPolicy(),
		compaction.NewNaiveSummarizer(),
		hooks,
	)

	return sc
}

// TrackUserMessage records a user message in the conversation history and
// increments the turn counter. Call this BEFORE sending the message to the
// provider.
func (sc *sessionCompaction) TrackUserMessage(text string) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	sc.messages = append(sc.messages, compaction.Message{Role: "user", Content: text})
	sc.turnCount++
	sc.turnsSinceCompact++
	sc.pendingUserMessage = text
}

// TrackAssistantMessage records an assistant message in the conversation history.
func (sc *sessionCompaction) TrackAssistantMessage(text string) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	sc.messages = append(sc.messages, compaction.Message{Role: "assistant", Content: text})
}

// TryProactiveCompaction evaluates the compaction policy and runs compaction
// if the threshold is exceeded. Call this BEFORE sending user input to the
// provider. Returns the compaction result (nil if not needed/cancelled) and
// any error.
func (sc *sessionCompaction) TryProactiveCompaction(ctx context.Context) (*compaction.CompactionResult, error) {
	sc.mu.Lock()
	state := compaction.ContextState{
		EstimatedTokens:       compaction.EstimateTokens(sc.messages),
		TurnCount:             sc.turnCount,
		LastCompactGeneration: sc.lastCompactGen,
		TurnsSinceCompact:     sc.turnsSinceCompact,
	}
	msgs := make([]compaction.Message, len(sc.messages))
	copy(msgs, sc.messages)
	sc.mu.Unlock()

	result, err := sc.executor.TryCompact(ctx, state, msgs)
	if err != nil {
		return result, err
	}

	if result != nil && !result.WasCancelled && result.Error == nil {
		sc.applyCompactionResult(result)
	}

	return result, nil
}

// ForceCompaction runs compaction unconditionally, bypassing policy checks.
// Use this to recover from context-overflow errors returned by the provider.
func (sc *sessionCompaction) ForceCompaction(ctx context.Context) (*compaction.CompactionResult, error) {
	sc.mu.Lock()
	msgs := make([]compaction.Message, len(sc.messages))
	copy(msgs, sc.messages)
	sc.mu.Unlock()

	result, err := sc.executor.ForceCompact(ctx, msgs)
	if err != nil {
		return result, err
	}

	if result != nil && result.Error == nil {
		sc.applyCompactionResult(result)
	}

	return result, nil
}

// applyCompactionResult updates the message history to reflect compaction.
// The compacted messages are replaced with a single summary message.
func (sc *sessionCompaction) applyCompactionResult(result *compaction.CompactionResult) {
	sc.mu.Lock()
	defer sc.mu.Unlock()

	if result.Summary.MessagesRemoved > 0 && result.Summary.MessagesRemoved <= len(sc.messages) {
		// Keep the messages that weren't removed and prepend the summary.
		kept := sc.messages[result.Summary.MessagesRemoved:]
		newMsgs := make([]compaction.Message, 0, len(kept)+1)
		newMsgs = append(newMsgs, compaction.Message{
			Role:    "system",
			Content: result.Summary.Summary,
		})
		newMsgs = append(newMsgs, kept...)
		sc.messages = newMsgs
	}
}

// IsCompacting returns whether compaction is currently in progress.
func (sc *sessionCompaction) IsCompacting() bool {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	return sc.isCompacting
}

// PendingUserMessage returns the last user message that was tracked.
// Used for reactive replay after overflow compaction.
func (sc *sessionCompaction) PendingUserMessage() string {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	return sc.pendingUserMessage
}

// persistCompactionResult writes a compaction entry to the session store.
func (sc *sessionCompaction) persistCompactionResult(result *compaction.CompactionResult) {
	if sc.store == nil {
		return
	}

	data, err := json.Marshal(map[string]any{
		"summary":          result.Summary.Summary,
		"tokensBefore":     result.Summary.TokensBefore,
		"tokensAfter":      result.Summary.TokensAfter,
		"messagesRemoved":  result.Summary.MessagesRemoved,
		"generation":       result.Generation,
	})
	if err != nil {
		sc.logger.Printf("session %s: marshal compaction event: %v", shortID(sc.sessionID), err)
		return
	}

	event := sessions.Event{
		Type:      "compaction",
		Timestamp: time.Now(),
		Data:      data,
	}

	if err := sc.store.AppendEvents(context.Background(), sc.sessionID, []sessions.Event{event}); err != nil {
		sc.logger.Printf("session %s: persist compaction event: %v", shortID(sc.sessionID), err)
	}
}

// emitCompactionSummaryMessage sends a message_update relay event with the
// compaction summary so the web UI displays it in the conversation.
func (sc *sessionCompaction) emitCompactionSummaryMessage(result *compaction.CompactionResult) {
	sc.emitEvent(RelayEvent{
		"type":    "message_update",
		"role":    "system",
		"content": fmt.Sprintf("🗜️ **Context compacted** — removed %d messages, %d→%d tokens (generation %d)",
			result.Summary.MessagesRemoved,
			result.Summary.TokensBefore,
			result.Summary.TokensAfter,
			result.Generation),
		"timestamp": time.Now().UnixMilli(),
		"meta": map[string]any{
			"isCompactionSummary": true,
			"tokensBefore":        result.Summary.TokensBefore,
			"tokensAfter":         result.Summary.TokensAfter,
			"messagesRemoved":     result.Summary.MessagesRemoved,
			"generation":          result.Generation,
		},
	})
}

// PersistEvent writes a single relay event to the session store as a durable
// event entry.
func (sc *sessionCompaction) PersistEvent(evType string, data map[string]any) {
	if sc.store == nil {
		return
	}

	jsonData, err := json.Marshal(data)
	if err != nil {
		sc.logger.Printf("session %s: marshal event for persistence: %v", shortID(sc.sessionID), err)
		return
	}

	event := sessions.Event{
		Type:      evType,
		Timestamp: time.Now(),
		Data:      jsonData,
	}

	if err := sc.store.AppendEvents(context.Background(), sc.sessionID, []sessions.Event{event}); err != nil {
		sc.logger.Printf("session %s: persist event: %v", shortID(sc.sessionID), err)
	}
}
