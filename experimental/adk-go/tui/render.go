package tui

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/lipgloss"
)

// Renderer handles markdown rendering for the TUI message display.
type Renderer struct {
	mu         sync.Mutex
	glamour    *glamour.TermRenderer
	cache      map[string]string
	width      int
	maxEntries int
}

// NewRenderer creates a markdown renderer with the given terminal width.
func NewRenderer(width int) *Renderer {
	if width < 20 {
		width = 80
	}
	r, _ := glamour.NewTermRenderer(
		glamour.WithStandardStyle("dark"),
		glamour.WithWordWrap(width-4),
	)
	return &Renderer{
		glamour:    r,
		cache:      make(map[string]string),
		width:      width,
		maxEntries: 200,
	}
}

// SetWidth updates the renderer's word wrap width. Clears the cache.
func (r *Renderer) SetWidth(width int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if width < 20 {
		width = 80
	}
	if width == r.width {
		return
	}
	r.width = width
	r.cache = make(map[string]string)
	newR, err := glamour.NewTermRenderer(
		glamour.WithStandardStyle("dark"),
		glamour.WithWordWrap(width-4),
	)
	if err == nil {
		r.glamour = newR
	}
}

// RenderMarkdown renders markdown text to styled terminal output.
func (r *Renderer) RenderMarkdown(text string) string {
	if text == "" {
		return ""
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if cached, ok := r.cache[text]; ok {
		return cached
	}

	rendered, err := r.glamour.Render(text)
	if err != nil {
		rendered = text
	}
	rendered = strings.TrimRight(rendered, "\n ")

	if len(r.cache) >= r.maxEntries {
		count := 0
		for k := range r.cache {
			delete(r.cache, k)
			count++
			if count >= r.maxEntries/2 {
				break
			}
		}
	}
	r.cache[text] = rendered

	return rendered
}

// RenderMessage renders a DisplayMessage into a styled string.
func (r *Renderer) RenderMessage(msg DisplayMessage, width int, state AppState) string {
	switch msg.Role {
	case "user":
		return renderUserMessage(msg)
	case "assistant":
		return renderAssistantMessage(r, msg, width, state)
	case "tool_result":
		return renderToolResult(msg, width)
	case "system":
		return dimStyle.Render("  " + msg.Text)
	default:
		return msg.Text
	}
}

// --- User message ---

func renderUserMessage(msg DisplayMessage) string {
	prefix := lipgloss.NewStyle().Foreground(colorUser).Bold(true).Render("❯ ")
	return "\n" + prefix + msg.Text + "\n"
}

// --- Assistant message ---

func renderAssistantMessage(r *Renderer, msg DisplayMessage, width int, state AppState) string {
	text := msg.Text

	// If this is the currently streaming message, append cursor
	if state.IsStreaming && msg.ID == state.StreamingMessageID {
		// Animated cursor: alternates between ▍ and space
		if state.TickCount%4 < 2 {
			text += "▍"
		} else {
			text += " "
		}
	}

	// Check for thinking block prefix
	if strings.HasPrefix(text, "[thinking]") {
		return renderThinkingBlock(text, state)
	}

	// Render markdown
	body := r.RenderMarkdown(text)
	return body
}

// --- Thinking block ---

func renderThinkingBlock(text string, state AppState) string {
	thinkingStyle := lipgloss.NewStyle().Foreground(colorThinking).Italic(true)

	// Strip [thinking] prefix
	content := strings.TrimPrefix(text, "[thinking] ")

	if state.IsStreaming {
		// Animated dots while thinking
		elapsed := ""
		if !state.ThinkingStart.IsZero() {
			dur := time.Since(state.ThinkingStart)
			elapsed = fmt.Sprintf(" %.1fs", dur.Seconds())
		}
		dots := strings.Repeat("·", (state.TickCount%3)+1)
		header := thinkingStyle.Render(fmt.Sprintf("  thinking %s%s", dots, elapsed))

		if content != "" {
			// Show truncated thinking content
			lines := strings.Split(content, "\n")
			if len(lines) > 2 {
				content = strings.Join(lines[:2], "\n") + "\n…"
			}
			return header + "\n" + thinkingStyle.Render("  "+content)
		}
		return header
	}

	// Collapsed thinking block (done)
	lines := strings.Split(content, "\n")
	summary := content
	if len(lines) > 1 {
		summary = lines[0]
		if len(summary) > 60 {
			summary = summary[:57] + "..."
		}
		summary += fmt.Sprintf(" (%d lines)", len(lines))
	}
	return thinkingStyle.Render("  💭 " + summary)
}

// --- Tool result ---

func renderToolResult(msg DisplayMessage, width int) string {
	// At very narrow widths (< 40), use compact inline rendering for all tools
	if width < 40 {
		return renderCompactToolResult(msg)
	}

	switch msg.ToolName {
	case "bash":
		return renderBashResult(msg, width)
	case "edit":
		return renderEditResult(msg, width)
	case "read":
		return renderReadResult(msg, width)
	case "write":
		return renderWriteResult(msg, width)
	default:
		return renderGenericToolResult(msg, width)
	}
}

// renderCompactToolResult renders a minimal tool result for narrow terminals.
func renderCompactToolResult(msg DisplayMessage) string {
	icon := "✓"
	style := lipgloss.NewStyle().Foreground(colorTool)
	if msg.IsError {
		icon = "✗"
		style = lipgloss.NewStyle().Foreground(colorError)
	}
	text := msg.Text
	if len(text) > 60 {
		text = text[:57] + "..."
	}
	// Replace newlines with spaces for compact display
	text = strings.ReplaceAll(text, "\n", " ")
	return style.Render(fmt.Sprintf("  %s %s: %s", icon, msg.ToolName, text)) + "\n"
}

// --- Bash tool result ---

func renderBashResult(msg DisplayMessage, width int) string {
	boxWidth := width - 4
	if boxWidth < 20 {
		boxWidth = 20
	}
	if boxWidth > width-2 {
		boxWidth = width - 2
	}

	// Header
	icon := "✓"
	headerColor := colorTool
	if msg.IsError {
		icon = "✗"
		headerColor = colorError
	}
	header := lipgloss.NewStyle().Foreground(headerColor).Bold(true).
		Render(fmt.Sprintf(" %s bash", icon))

	// Content — truncate
	content := msg.Text
	lines := strings.Split(content, "\n")
	if len(lines) > 8 {
		content = strings.Join(lines[:8], "\n")
		content += fmt.Sprintf("\n  … %d more lines", len(lines)-8)
	}

	// Box
	border := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorDim).
		Width(boxWidth).
		Padding(0, 1)

	return header + "\n" + border.Render(dimStyle.Render(content)) + "\n"
}

// --- Edit tool result ---

func renderEditResult(msg DisplayMessage, width int) string {
	boxWidth := width - 4
	if boxWidth < 20 {
		boxWidth = 20
	}
	if boxWidth > width-2 {
		boxWidth = width - 2
	}

	icon := "✓"
	headerColor := colorTool
	if msg.IsError {
		icon = "✗"
		headerColor = colorError
	}
	header := lipgloss.NewStyle().Foreground(headerColor).Bold(true).
		Render(fmt.Sprintf(" %s edit", icon))

	// Color diff lines
	content := msg.Text
	var coloredLines []string
	for _, line := range strings.Split(content, "\n") {
		if strings.HasPrefix(line, "+") {
			coloredLines = append(coloredLines,
				lipgloss.NewStyle().Foreground(colorDiffAdd).Render(line))
		} else if strings.HasPrefix(line, "-") {
			coloredLines = append(coloredLines,
				lipgloss.NewStyle().Foreground(colorDiffDel).Render(line))
		} else if strings.HasPrefix(line, "@@") {
			coloredLines = append(coloredLines,
				lipgloss.NewStyle().Foreground(colorThinking).Render(line))
		} else {
			coloredLines = append(coloredLines, dimStyle.Render(line))
		}
	}

	// Truncate
	if len(coloredLines) > 12 {
		coloredLines = coloredLines[:12]
		coloredLines = append(coloredLines,
			dimStyle.Render(fmt.Sprintf("  … %d more lines", len(strings.Split(content, "\n"))-12)))
	}

	border := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorDim).
		Width(boxWidth).
		Padding(0, 1)

	return header + "\n" + border.Render(strings.Join(coloredLines, "\n")) + "\n"
}

// --- Read tool result ---

func renderReadResult(msg DisplayMessage, width int) string {
	boxWidth := width - 4
	if boxWidth < 20 {
		boxWidth = 20
	}
	if boxWidth > width-2 {
		boxWidth = width - 2
	}

	icon := "✓"
	headerColor := colorTool
	if msg.IsError {
		icon = "✗"
		headerColor = colorError
	}
	header := lipgloss.NewStyle().Foreground(headerColor).Bold(true).
		Render(fmt.Sprintf(" %s read", icon))

	content := msg.Text
	lines := strings.Split(content, "\n")
	if len(lines) > 6 {
		content = strings.Join(lines[:6], "\n")
		content += fmt.Sprintf("\n  … %d more lines", len(lines)-6)
	}

	border := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorDim).
		Width(boxWidth).
		Padding(0, 1)

	return header + "\n" + border.Render(dimStyle.Render(content)) + "\n"
}

// --- Write tool result ---

func renderWriteResult(msg DisplayMessage, width int) string {
	icon := "✓"
	style := lipgloss.NewStyle().Foreground(colorTool)
	if msg.IsError {
		icon = "✗"
		style = lipgloss.NewStyle().Foreground(colorError)
	}

	// Write results are typically short — render inline
	text := msg.Text
	if len(text) > 80 {
		text = text[:77] + "..."
	}
	return style.Render(fmt.Sprintf("  %s write: %s", icon, text)) + "\n"
}

// --- Generic tool result ---

func renderGenericToolResult(msg DisplayMessage, width int) string {
	boxWidth := width - 4
	if boxWidth < 20 {
		boxWidth = 20
	}
	if boxWidth > width-2 {
		boxWidth = width - 2
	}

	icon := "✓"
	headerColor := colorTool
	if msg.IsError {
		icon = "✗"
		headerColor = colorError
	}
	header := lipgloss.NewStyle().Foreground(headerColor).Bold(true).
		Render(fmt.Sprintf(" %s %s", icon, msg.ToolName))

	content := msg.Text
	if len(content) > 500 {
		content = content[:497] + "..."
	}

	border := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorDim).
		Width(boxWidth).
		Padding(0, 1)

	return header + "\n" + border.Render(dimStyle.Render(content)) + "\n"
}
