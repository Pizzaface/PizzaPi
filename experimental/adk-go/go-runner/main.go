// go-runner is a minimal PizzaPi runner daemon backed by the Claude CLI.
//
// It connects to the PizzaPi relay server via Socket.IO, registers as a
// runner, and spawns claude CLI subprocesses in response to new_session
// events. Claude CLI events are converted to PizzaPi relay events via the
// adapter from the claude-wrapper package and forwarded to the relay.
//
// This is the Phase 0 prototype: one session at a time, no compaction,
// no triggers, no services, no hooks, no MCP, no PTY.
//
// Usage:
//
//	PIZZAPI_API_KEY=<key> go run . [--relay-url http://localhost:7492] [--runner-name my-go-runner]
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"sync"
	"syscall"
	"time"
)

const version = "0.1.0-phase0"

// session tracks a running provider session.
type session struct {
	sessionID    string
	provider     Provider      // LLM backend (Claude CLI, API, etc.)
	relaySession *RelaySession // per-session /relay connection
	cancel       context.CancelFunc
	killed       bool
	mu           sync.Mutex
}

// GoRunner is the Phase 0 PizzaPi runner daemon.
type GoRunner struct {
	relayURL   string
	apiKey     string
	runnerID   string
	runnerName string

	client   *SIOClient
	sessions sync.Map // sessionID → *session
	logger   *log.Logger
	stop     context.CancelFunc // signals Run() to exit
}

// NewGoRunner creates a new runner daemon.
func NewGoRunner(relayURL, apiKey, runnerID, runnerName string) *GoRunner {
	return &GoRunner{
		relayURL:   relayURL,
		apiKey:     apiKey,
		runnerID:   runnerID,
		runnerName: runnerName,
		logger:     log.New(os.Stderr, "[go-runner] ", log.LstdFlags|log.Lmsgprefix),
	}
}

// Run connects to the relay and handles events until ctx is cancelled.
func (r *GoRunner) Run(ctx context.Context) error {
	r.client = NewSIOClient(SIOClientConfig{
		URL:       r.relayURL,
		Namespace: "/runner",
		Auth: map[string]any{
			"apiKey":          r.apiKey,
			"runnerId":        r.runnerID,
			"protocolVersion": 1,
			"clientVersion":   version,
		},
		Logger: r.logger,
		OnConnect: func() {
			r.logger.Printf("connected to relay, registering as %s", r.runnerID)
			r.emitRegister()
		},
		OnDisconnect: func(reason string) {
			r.logger.Printf("disconnected from relay: %s", reason)
		},
	})

	// Internal stop signal — triggered by shutdown/restart commands
	stopCtx, stopCancel := context.WithCancel(ctx)
	r.stop = stopCancel

	// Register event handlers
	r.client.On("runner_registered", r.handleRunnerRegistered)
	r.client.On("new_session", r.handleNewSession)
	r.client.On("kill_session", r.handleKillSession)
	r.client.On("session_ended", r.handleSessionEnded)
	r.client.On("restart", r.handleRestart)
	r.client.On("shutdown", r.handleShutdown)
	r.client.On("list_sessions", r.handleListSessions)
	r.client.On("ping", r.handlePing)
	r.client.On("error", r.handleError)

	if err := r.client.Connect(); err != nil {
		return fmt.Errorf("connect to relay: %w", err)
	}

	// Wait for shutdown
	select {
	case <-stopCtx.Done():
		r.logger.Println("shutting down...")
	case <-r.client.Done():
		r.logger.Println("relay connection lost")
	}

	// Kill all sessions
	r.sessions.Range(func(key, value any) bool {
		sess := value.(*session)
		r.killSession(sess)
		return true
	})

	r.client.Close()
	return nil
}

func (r *GoRunner) emitRegister() {
	hostname, _ := os.Hostname()
	name := r.runnerName
	if name == "" {
		name = hostname
	}

	r.client.Emit("register_runner", map[string]any{
		"runnerId": r.runnerID,
		"name":     name,
		"roots":    []string{},
		"skills":   []any{},
		"agents":   []any{},
		"plugins":  []any{},
		"hooks":    []any{},
		"version":  version,
		"platform": runtime.GOOS,
	})
}

func (r *GoRunner) handleRunnerRegistered(data json.RawMessage) {
	var payload struct {
		RunnerID         string `json:"runnerId"`
		ExistingSessions []struct {
			SessionID string `json:"sessionId"`
			Cwd       string `json:"cwd"`
		} `json:"existingSessions"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		r.logger.Printf("parse runner_registered: %v", err)
		return
	}

	r.runnerID = payload.RunnerID
	r.logger.Printf("registered as %s", r.runnerID)

	if len(payload.ExistingSessions) > 0 {
		r.logger.Printf("found %d existing sessions (adoption not implemented in Phase 0)", len(payload.ExistingSessions))
	}
}

func (r *GoRunner) handleNewSession(data json.RawMessage) {
	var payload struct {
		SessionID       string `json:"sessionId"`
		Cwd             string `json:"cwd"`
		Prompt          string `json:"prompt"`
		Model           *struct {
			Provider string `json:"provider"`
			ID       string `json:"id"`
		} `json:"model"`
		ParentSessionID string `json:"parentSessionId"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		r.logger.Printf("parse new_session: %v", err)
		return
	}

	sessionID := payload.SessionID
	r.logger.Printf("new_session: id=%s cwd=%s", sessionID, payload.Cwd)

	// Check for duplicate
	if _, loaded := r.sessions.Load(sessionID); loaded {
		r.logger.Printf("session %s already running, ignoring", sessionID)
		return
	}

	// Determine the initial prompt
	prompt := payload.Prompt
	if prompt == "" {
		prompt = "Hello! I'm ready to help."
	}

	// Resolve model
	model := ""
	if payload.Model != nil && payload.Model.ID != "" {
		model = payload.Model.ID
	}

	// Create provider — currently always Claude CLI.
	// Future: select provider based on model prefix, config, etc.
	provider := NewClaudeCLIProvider(r.logger)

	// Create and track the session
	ctx, cancel := context.WithCancel(context.Background())
	sess := &session{
		sessionID: sessionID,
		provider:  provider,
		cancel:    cancel,
	}
	r.sessions.Store(sessionID, sess)

	// Spawn the provider session
	go r.runSession(ctx, sess, ProviderContext{
		Prompt: prompt,
		Cwd:    payload.Cwd,
		Model:  model,
		OnStderr: func(line string) {
			r.logger.Printf("[session:%s:stderr] %s", sessionID[:8], line)
		},
	})
}

func (r *GoRunner) runSession(ctx context.Context, sess *session, pctx ProviderContext) {
	sessionID := sess.sessionID
	cwd := pctx.Cwd

	// Connect to /relay to register the session in the session store.
	// This is what makes the session visible to the web UI.
	relaySess := NewRelaySession(r.relayURL, r.apiKey, sessionID, cwd, r.logger)

	// Wire up user input from web UI → provider
	relaySess.onInput = func(text string) {
		r.logger.Printf("session %s: sending user input to provider", sessionID[:8])

		if err := sess.provider.SendMessage(text); err != nil {
			r.logger.Printf("session %s: send message error: %v", sessionID[:8], err)
			return
		}

		// Emit active heartbeat so the UI shows the spinner
		activeHB := map[string]any{
			"type":         "heartbeat",
			"active":       true,
			"isCompacting": false,
			"ts":           time.Now().UnixMilli(),
		}
		r.client.Emit("runner_session_event", map[string]any{
			"sessionId": sessionID,
			"event":     activeHB,
		})
		if relaySess != nil {
			relaySess.EmitEvent(activeHB)
		}
	}

	if err := relaySess.Connect(r.relayURL, r.apiKey, cwd); err != nil {
		r.logger.Printf("session %s relay registration failed: %v", sessionID[:8], err)
		r.client.Emit("session_error", map[string]any{
			"sessionId": sessionID,
			"message":   fmt.Sprintf("relay registration failed: %v", err),
		})
		r.sessions.Delete(sessionID)
		return
	}
	sess.relaySession = relaySess

	// Start the provider
	events, err := sess.provider.Start(pctx)
	if err != nil {
		r.logger.Printf("session %s start error: %v", sessionID[:8], err)
		r.client.Emit("session_error", map[string]any{
			"sessionId": sessionID,
			"message":   err.Error(),
		})
		relaySess.Close()
		r.sessions.Delete(sessionID)
		return
	}

	// Session is ready
	r.client.Emit("session_ready", map[string]any{
		"sessionId": sessionID,
	})
	r.logger.Printf("session %s ready", sessionID[:8])

	// Start a heartbeat ticker
	heartbeatTicker := time.NewTicker(10 * time.Second)
	defer heartbeatTicker.Stop()

	// Forward events to relay
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				// Events channel closed — provider exited
				r.handleSessionExit(sess)
				return
			}

			evType, _ := ev["type"].(string)
			r.logger.Printf("session %s relay event: %v", sessionID[:8], evType)

			// Forward via the /relay session connection — this goes through
			// the server's event pipeline (state caching, image stripping,
			// viewer broadcast). This is the primary event delivery path.
			if sess.relaySession != nil {
				sess.relaySession.EmitEvent(ev)
			}

			// Only forward heartbeats via runner protocol — the relay needs
			// them for session liveness tracking. All other events go
			// exclusively through /relay to avoid double-publishing.
			if evType == "heartbeat" {
				r.client.Emit("runner_session_event", map[string]any{
					"sessionId": sessionID,
					"event":     ev,
				})
			}

		case <-heartbeatTicker.C:
			r.client.Emit("runner_session_event", map[string]any{
				"sessionId": sessionID,
				"event": map[string]any{
					"type":         "heartbeat",
					"active":       true,
					"isCompacting": false,
					"ts":           time.Now().UnixMilli(),
				},
			})

		case <-ctx.Done():
			return
		}
	}
}

func (r *GoRunner) handleSessionExit(sess *session) {
	sessionID := sess.sessionID

	// Close the relay session connection
	if sess.relaySession != nil {
		sess.relaySession.Close()
	}

	// Wait for provider to fully exit
	<-sess.provider.Done()

	exitCode := sess.provider.ExitCode()
	r.logger.Printf("session %s exited (code=%d)", sessionID[:8], exitCode)

	// Send final inactive heartbeat
	r.client.Emit("runner_session_event", map[string]any{
		"sessionId": sessionID,
		"event": map[string]any{
			"type":         "heartbeat",
			"active":       false,
			"isCompacting": false,
			"ts":           time.Now().UnixMilli(),
		},
	})

	sess.mu.Lock()
	wasKilled := sess.killed
	sess.mu.Unlock()

	if wasKilled {
		r.client.Emit("session_killed", map[string]any{
			"sessionId": sessionID,
		})
	}

	r.sessions.Delete(sessionID)
}

func (r *GoRunner) handleKillSession(data json.RawMessage) {
	var payload struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		r.logger.Printf("parse kill_session: %v", err)
		return
	}

	r.logger.Printf("kill_session: %s", payload.SessionID[:8])

	val, ok := r.sessions.Load(payload.SessionID)
	if !ok {
		r.logger.Printf("session %s not found for kill", payload.SessionID[:8])
		return
	}

	sess := val.(*session)
	r.killSession(sess)
}

func (r *GoRunner) killSession(sess *session) {
	sess.mu.Lock()
	sess.killed = true
	sess.mu.Unlock()

	// Stop the provider (sends SIGTERM for subprocess providers)
	sess.provider.Stop()
	sess.cancel()

	// Wait for provider exit with timeout
	select {
	case <-sess.provider.Done():
	case <-time.After(10 * time.Second):
		r.logger.Printf("session %s did not exit after stop, force killed", sess.sessionID[:8])
	}
}

func (r *GoRunner) handleSessionEnded(data json.RawMessage) {
	var payload struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		r.logger.Printf("parse session_ended: %v", err)
		return
	}
	r.logger.Printf("session_ended from relay: %s", payload.SessionID[:8])
	r.sessions.Delete(payload.SessionID)
}

func (r *GoRunner) handleRestart(_ json.RawMessage) {
	r.logger.Println("restart requested by relay — killing all sessions and exiting")
	r.sessions.Range(func(key, value any) bool {
		sess := value.(*session)
		r.killSession(sess)
		return true
	})
	if r.stop != nil {
		r.stop()
	}
}

func (r *GoRunner) handleShutdown(_ json.RawMessage) {
	r.logger.Println("shutdown requested by relay — killing all sessions and exiting")
	r.sessions.Range(func(key, value any) bool {
		sess := value.(*session)
		r.killSession(sess)
		return true
	})
	if r.stop != nil {
		r.stop()
	}
}

func (r *GoRunner) handleListSessions(_ json.RawMessage) {
	var ids []string
	r.sessions.Range(func(key, value any) bool {
		ids = append(ids, key.(string))
		return true
	})
	r.logger.Printf("list_sessions: %d active", len(ids))
	// The protocol doesn't define a response event for list_sessions,
	// but log it for observability.
}

func (r *GoRunner) handlePing(_ json.RawMessage) {
	// Relay health check — no-op, just being alive is the answer
}

func (r *GoRunner) handleError(data json.RawMessage) {
	var payload struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		r.logger.Printf("relay error: %s", string(data))
		return
	}
	r.logger.Printf("relay error: %s", payload.Message)
}

func main() {
	relayURL := flag.String("relay-url", "", "PizzaPi relay URL (default: PIZZAPI_RELAY_URL or http://localhost:7492)")
	runnerName := flag.String("runner-name", "", "Runner display name (default: hostname)")
	runnerID := flag.String("runner-id", "", "Runner ID (default: go-runner-<hostname>)")
	flag.Parse()

	// Resolve relay URL
	url := *relayURL
	if url == "" {
		url = os.Getenv("PIZZAPI_RELAY_URL")
	}
	if url == "" {
		url = "http://localhost:7492"
	}
	// Normalize ws:// to http:// for our client
	if len(url) > 5 && url[:5] == "ws://" {
		url = "http://" + url[5:]
	} else if len(url) > 6 && url[:6] == "wss://" {
		url = "https://" + url[6:]
	}

	// Resolve API key
	apiKey := os.Getenv("PIZZAPI_API_KEY")
	if apiKey == "" {
		apiKey = os.Getenv("PIZZAPI_API_TOKEN")
	}
	if apiKey == "" {
		fmt.Fprintln(os.Stderr, "error: PIZZAPI_API_KEY environment variable is required")
		os.Exit(1)
	}

	// Resolve runner ID
	id := *runnerID
	if id == "" {
		hostname, _ := os.Hostname()
		id = "go-runner-" + hostname
	}

	runner := NewGoRunner(url, apiKey, id, *runnerName)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := runner.Run(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}
