package claudewrapper

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseLine(t *testing.T) {
	tests := []struct {
		name string
		line string
		check func(t *testing.T, event ClaudeEvent)
	}{
		{
			name: "system event",
			line: `{"type":"system","session_id":"sess_123","tools":["bash","read"],"cwd":"/tmp","model":"claude-sonnet-4-20250514"}`,
			check: func(t *testing.T, event ClaudeEvent) {
				e, ok := event.(*SystemEvent)
				if !ok { t.Fatalf("got %T", event) }
				if e.SessionID != "sess_123" || e.Cwd != "/tmp" || e.Model != "claude-sonnet-4-20250514" { t.Fatalf("unexpected event: %+v", e) }
				if len(e.Tools) != 2 || e.Tools[0] != "bash" || e.Tools[1] != "read" { t.Fatalf("unexpected tools: %+v", e.Tools) }
			},
		},
		{
			name: "text delta",
			line: `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}`,
			check: func(t *testing.T, event ClaudeEvent) {
				e, ok := event.(*ContentBlockDelta)
				if !ok { t.Fatalf("got %T", event) }
				if e.Index != 0 || e.DeltaType != "text_delta" || e.Text != "Hello" { t.Fatalf("unexpected event: %+v", e) }
			},
		},
		{
			name: "tool_use content_block_start",
			line: `{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_abc","name":"bash"}}}`,
			check: func(t *testing.T, event ClaudeEvent) {
				e, ok := event.(*ContentBlockStart)
				if !ok { t.Fatalf("got %T", event) }
				if e.Index != 1 || e.BlockType != "tool_use" || e.ToolID != "tool_abc" || e.ToolName != "bash" { t.Fatalf("unexpected event: %+v", e) }
			},
		},
		{
			name: "content_block_stop",
			line: `{"type":"stream_event","event":{"type":"content_block_stop","index":0}}`,
			check: func(t *testing.T, event ClaudeEvent) {
				e, ok := event.(*ContentBlockStop)
				if !ok { t.Fatalf("got %T", event) }
				if e.Index != 0 { t.Fatalf("unexpected event: %+v", e) }
			},
		},
		{
			name: "message_start",
			line: `{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_01","role":"assistant","model":"claude-sonnet-4-20250514","usage":{"input_tokens":100,"output_tokens":0}}}}`,
			check: func(t *testing.T, event ClaudeEvent) {
				e, ok := event.(*MessageStart)
				if !ok { t.Fatalf("got %T", event) }
				if e.MessageID != "msg_01" || e.Role != "assistant" || e.Model != "claude-sonnet-4-20250514" || e.InputTokens != 100 { t.Fatalf("unexpected event: %+v", e) }
			},
		},
		{
			name: "message_delta",
			line: `{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}}`,
			check: func(t *testing.T, event ClaudeEvent) {
				e, ok := event.(*MessageDelta)
				if !ok { t.Fatalf("got %T", event) }
				if e.StopReason != "end_turn" || e.OutputTokens != 50 { t.Fatalf("unexpected event: %+v", e) }
			},
		},
		{
			name: "message_stop",
			line: `{"type":"stream_event","event":{"type":"message_stop"}}`,
			check: func(t *testing.T, event ClaudeEvent) {
				if _, ok := event.(*MessageStop); !ok { t.Fatalf("got %T", event) }
			},
		},
		{
			name: "assistant message",
			line: `{"type":"assistant","message":{"id":"msg_01","role":"assistant","content":[{"type":"text","text":"Hello world"}]}}`,
			check: func(t *testing.T, event ClaudeEvent) {
				e, ok := event.(*AssistantMessage)
				if !ok { t.Fatalf("got %T", event) }
				var payload map[string]any
				if err := json.Unmarshal(e.Message, &payload); err != nil { t.Fatalf("unmarshal raw: %v", err) }
				if payload["id"] != "msg_01" { t.Fatalf("unexpected raw payload: %+v", payload) }
			},
		},
		{
			name: "tool_use event",
			line: `{"type":"tool_use","tool_use_id":"tool_abc","name":"bash","input":{"command":"ls"}}`,
			check: func(t *testing.T, event ClaudeEvent) {
				e, ok := event.(*ToolUseEvent)
				if !ok { t.Fatalf("got %T", event) }
				if e.ToolID != "tool_abc" || e.Name != "bash" { t.Fatalf("unexpected event: %+v", e) }
				var payload map[string]any
				if err := json.Unmarshal(e.Input, &payload); err != nil { t.Fatalf("unmarshal input: %v", err) }
				if payload["command"] != "ls" { t.Fatalf("unexpected input: %+v", payload) }
			},
		},
		{
			name: "tool_result",
			line: "{\"type\":\"tool_result\",\"tool_use_id\":\"tool_abc\",\"content\":\"file1.txt\\nfile2.txt\",\"is_error\":false}",
			check: func(t *testing.T, event ClaudeEvent) {
				e, ok := event.(*ToolResultEvent)
				if !ok { t.Fatalf("got %T", event) }
				if e.ToolID != "tool_abc" || e.Content != "file1.txt\nfile2.txt" || e.IsError { t.Fatalf("unexpected event: %+v", e) }
			},
		},
		{
			name: "result event",
			line: `{"type":"result","subtype":"success","is_error":false,"session_id":"sess_123","total_cost_usd":0.05,"duration_ms":3000,"num_turns":1,"stop_reason":"end_turn","result":"Hello world","usage":{"input_tokens":500,"output_tokens":200}}`,
			check: func(t *testing.T, event ClaudeEvent) {
				e, ok := event.(*ResultEvent)
				if !ok { t.Fatalf("got %T", event) }
				if e.SessionID != "sess_123" || e.TotalCostUSD != 0.05 || e.DurationMs != 3000 { t.Fatalf("unexpected event: %+v", e) }
				if e.InputTokens != 500 || e.OutputTokens != 200 { t.Fatalf("unexpected tokens: %+v", e) }
				if e.Subtype != "success" || e.StopReason != "end_turn" || e.NumTurns != 1 { t.Fatalf("unexpected meta: %+v", e) }
				if e.Result != "Hello world" { t.Fatalf("unexpected result text: %q", e.Result) }
			},
		},
		{
			name: "rate_limit_event",
			line: `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1775174400,"rateLimitType":"five_hour","isUsingOverage":false}}`,
			check: func(t *testing.T, event ClaudeEvent) {
				e, ok := event.(*RateLimitEvent)
				if !ok { t.Fatalf("got %T", event) }
				if e.Status != "allowed" || e.LimitType != "five_hour" || e.IsOverage { t.Fatalf("unexpected event: %+v", e) }
			},
		},
		{
			name: "user message (tool result)",
			line: `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_abc","type":"tool_result","content":"output","is_error":false}]}}`,
			check: func(t *testing.T, event ClaudeEvent) {
				e, ok := event.(*UserMessage)
				if !ok { t.Fatalf("got %T", event) }
				if e.ToolUseID != "toolu_abc" || e.Content != "output" || e.IsError { t.Fatalf("unexpected event: %+v", e) }
			},
		},
		{
			name: "unknown type",
			line: `{"type":"custom_event","data":"something"}`,
			check: func(t *testing.T, event ClaudeEvent) {
				e, ok := event.(*UnknownEvent)
				if !ok { t.Fatalf("got %T", event) }
				if e.RawType != "custom_event" { t.Fatalf("unexpected event: %+v", e) }
			},
		},
		{
			name: "malformed JSON",
			line: `{not valid json`,
			check: func(t *testing.T, event ClaudeEvent) {
				e, ok := event.(*ParseError)
				if !ok { t.Fatalf("got %T", event) }
				if e.Line != `{not valid json` || e.Message == "" { t.Fatalf("unexpected event: %+v", e) }
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.check(t, ParseLine([]byte(tt.line)))
		})
	}
}

func TestParseStream(t *testing.T) {
	reader := strings.NewReader(strings.Join([]string{
		`{"type":"system","session_id":"sess_123","tools":["bash"],"cwd":"/tmp","model":"claude-sonnet-4-20250514"}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}`,
		`{"type":"result","subtype":"success","session_id":"sess_123","total_cost_usd":0.05,"duration_ms":3000,"usage":{"input_tokens":500,"output_tokens":200}}`,
	}, "\n"))

	events := make(chan ClaudeEvent)
	go ParseStream(reader, events)

	var got []ClaudeEvent
	for event := range events {
		got = append(got, event)
	}

	if len(got) != 3 {
		t.Fatalf("expected 3 events, got %d", len(got))
	}
	if _, ok := got[0].(*SystemEvent); !ok { t.Fatalf("first event = %T", got[0]) }
	if _, ok := got[1].(*ContentBlockDelta); !ok { t.Fatalf("second event = %T", got[1]) }
	if _, ok := got[2].(*ResultEvent); !ok { t.Fatalf("third event = %T", got[2]) }
}
