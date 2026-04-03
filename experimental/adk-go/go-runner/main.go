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
	cancel       context.CancelFunc // cancels the session goroutine (both adopted and normal)
	killed       bool
	adopted      bool // true if this session was adopted from relay on reconnect (no subprocess)
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

	// Adopt sessions that the relay knows about but we don't have locally.
	// These are placeholder entries with no subprocess — they represent sessions
	// that were running before a disconnect/restart.
	for _, es := range payload.ExistingSessions {
		sessionID := es.SessionID
		if _, exists := r.sessions.Load(sessionID); exists {
			// Already tracked locally — alive, no action needed.
			r.logger.Printf("session %s already tracked locally, skipping adoption", sessionID[:min(8, len(sessionID))])
			continue
		}

		// Create an adopted (placeholder) session entry with no subprocess.
		// A cancel function is stored so killSession can cancel the goroutine
		// even if it is still blocking inside relaySess.Connect().
		ctx, cancel := context.WithCancel(context.Background())
		adopted := &session{
			sessionID: sessionID,
			adopted:   true,
			cancel:    cancel,
		}
		r.sessions.Store(sessionID, adopted)
		r.logger.Printf("adopted session %s (no subprocess)", sessionID[:min(8, len(sessionID))])

		// Emit an inactive heartbeat so the UI knows this session exists but isn't running.
		r.client.Emit("runner_session_event", map[string]any{
			"sessionId": sessionID,
			"event": map[string]any{
				"type":         "heartbeat",
				"active":       false,
				"isCompacting": false,
				"ts":           time.Now().UnixMilli(),
			},
		})

		// Connect a relay session for the adopted session to observe user input.
		// The adopted session has no subprocess, so any input is logged as a warning.
		go r.runAdoptedSession(ctx, adopted, es.Cwd)
	}

	if len(payload.ExistingSessions) > 0 {
		r.logger.Printf("adopted %d existing sessions from relay", len(payload.ExistingSessions))
	}
}

// runAdoptedSession connects an adopted (no-subprocess) session to the relay
// so that user input is properly received and logged as a warning.
// The session has no subprocess, so input cannot be forwarded.
//
// ctx is cancelled by killSession to interrupt a blocking Connect() call or
// to stop the goroutine while it is waiting on the relay connection.
func (r *GoRunner) runAdoptedSession(ctx context.Context, sess *session, cwd string) {
	sessionID := sess.sessionID
	shortID := sessionID[:min(8, len(sessionID))]

	// Always remove the session from the map when this goroutine exits,
	// regardless of whether exit was caused by kill or relay disconnect.
	defer r.sessions.Delete(sessionID)

	relaySess := NewRelaySession(r.relayURL, r.apiKey, sessionID, cwd, r.logger)

	// Log a warning when input arrives — no subprocess to forward to.
	relaySess.onInput = func(text string) {
		r.logger.Printf("session %s: received input for adopted session (no subprocess, cannot forward): %s",
			shortID, text[:min(len(text), 80)])
	}

	if err := relaySess.Connect(r.relayURL, r.apiKey, cwd); err != nil {
		r.logger.Printf("adopted session %s relay registration failed: %v", shortID, err)
		return
	}

	// Check whether killSession cancelled us while Connect() was blocking.
	select {
	case <-ctx.Done():
		relaySess.Close()
		r.logger.Printf("adopted session %s cancelled after connect", shortID)
		return
	default:
	}

	sess.mu.Lock()
	sess.relaySession = relaySess
	sess.mu.Unlock()

	r.logger.Printf("adopted session %s relay connected (monitoring for input)", shortID)

	// Wait until the session is killed (ctx cancelled) or the relay disconnects.
	// RelaySession.Done() only closes on explicit Close(); use ctx.Done() so a
	// kill_session that arrives before or after Connect() always unblocks us.
	select {
	case <-ctx.Done():
		relaySess.Close()
		r.logger.Printf("adopted session %s killed", shortID)
	case <-relaySess.Done():
		r.logger.Printf("adopted session %s relay disconnected", shortID)
	}
}

func (r *GoRunner) handleNewSession(data json.RawMessage) {
	var payload struct {
		SessionID string `json:"sessionId"`
		Cwd       string `json:"cwd"`
		Prompt    string `json:"prompt"`
		Model     *struct {
			Provider string `json:"provider"`
			ID       string `json:"id"`
		} `json:"model"`
		ParentSessionID string `json:"parentSessionId"`
		// Resume fields — if set, the provider resumes an existing Claude session.
		ResumeID   string `json:"resumeId"`
		ResumePath string `json:"resumePath"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		r.logger.Printf("parse new_session: %v", err)
		return
	}

	sessionID := payload.SessionID
	r.logger.Printf("new_session: id=%s cwd=%s resumeId=%s", sessionID, payload.Cwd, payload.ResumeID)

	// Check for duplicate
	if _, loaded := r.sessions.Load(sessionID); loaded {
		r.logger.Printf("session %s already running, ignoring", sessionID)
		return
	}

	// Determine the initial prompt.
	// When resuming, an empty prompt is valid — the provider will continue
	// the existing conversation without injecting a new message.
	prompt := payload.Prompt
	if prompt == "" && payload.ResumeID == "" && payload.ResumePath == "" {
		// Not resuming and no prompt — supply a default greeting.
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
		Prompt:     prompt,
		Cwd:        payload.Cwd,
		Model:      model,
		ResumeID:   payload.ResumeID,
		ResumePath: payload.ResumePath,
		OnStderr: func(line string) {
			r.logger.Printf("[session:%s:stderr] %s", sessionID[:min(8, len(sessionID))], line)
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

	sessionID := payload.SessionID
	r.logger.Printf("kill_session: %s", sessionID[:min(8, len(sessionID))])

	val, ok := r.sessions.Load(sessionID)
	if !ok {
		r.logger.Printf("session %s not found for kill", sessionID[:min(8, len(sessionID))])
		return
	}

	sess := val.(*session)

	// Adopted sessions have no subprocess — just clean up the placeholder entry.
	sess.mu.Lock()
	isAdopted := sess.adopted
	sess.mu.Unlock()

	if isAdopted {
		r.logger.Printf("kill_session: session %s is adopted (no subprocess), cancelling", sessionID[:min(8, len(sessionID))])
		// Cancel the adopted session goroutine. This unblocks runAdoptedSession
		// whether it is still inside Connect() or waiting on relaySess.Done().
		// The goroutine's defer will also call r.sessions.Delete; we delete here
		// too so that sessions injected without a running goroutine (e.g. tests)
		// are also cleaned up. sync.Map.Delete is idempotent — double-delete is safe.
		if sess.cancel != nil {
			sess.cancel()
		}
		r.sessions.Delete(sessionID)
		r.client.Emit("session_killed", map[string]any{
			"sessionId": sessionID,
		})
		return
	}

	r.killSession(sess)
}

func (r *GoRunner) killSession(sess *session) {
	sess.mu.Lock()
	isAdopted := sess.adopted
	sess.killed = true
	sess.mu.Unlock()

	// Adopted sessions have no subprocess — cancel the goroutine and let it clean up.
	if isAdopted {
		if sess.cancel != nil {
			sess.cancel()
		}
		return
	}

	// Stop the provider (sends SIGTERM for subprocess providers)
	sess.provider.Stop()
	if sess.cancel != nil {
		sess.cancel()
	}

	// Wait for provider exit with timeout
	select {
	case <-sess.provider.Done():
	case <-time.After(10 * time.Second):
		r.logger.Printf("session %s did not exit after stop, force killed", sess.sessionID[:min(8, len(sess.sessionID))])
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
	r.logger.Printf("session_ended from relay: %s", payload.SessionID[:min(8, len(payload.SessionID))])
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
