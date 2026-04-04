package tui

import (
	"fmt"
	"strings"
	"sync"

	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/lipgloss"
)

// Renderer handles markdown rendering for the TUI message display.
// It caches rendered output to avoid re-rendering unchanged content.
type Renderer struct {
	mu         sync.Mutex
	glamour    *glamour.TermRenderer
	cache      map[string]string // text → rendered output
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
		glamour.WithWordWrap(width-4), // leave margin for role prefix
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
// Results are cached by input text.
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
		// Fallback to plain text
		rendered = text
	}

	// Trim trailing whitespace/newlines glamour adds
	rendered = strings.TrimRight(rendered, "\n ")

	// Evict oldest entries if cache is full
	if len(r.cache) >= r.maxEntries {
		// Simple eviction: clear half the cache
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

// RenderMessage renders a DisplayMessage into a styled string for the terminal.
func (r *Renderer) RenderMessage(msg DisplayMessage, width int) string {
	switch msg.Role {
	case "user":
		prefix := lipgloss.NewStyle().Foreground(colorUser).Bold(true).Render("❯ ")
		// User messages are typically short — render as markdown
		body := r.RenderMarkdown(msg.Text)
		return prefix + indentAfterFirst(body, "  ")

	case "assistant":
		// Assistant messages are the main output — full markdown rendering
		body := r.RenderMarkdown(msg.Text)
		return body

	case "tool_result":
		return renderToolResult(msg, width)

	case "system":
		return lipgloss.NewStyle().Foreground(colorDim).Italic(true).Render(msg.Text)

	default:
		return msg.Text
	}
}

// renderToolResult renders a tool result as a compact card.
func renderToolResult(msg DisplayMessage, width int) string {
	icon := "✓"
	nameColor := colorTool
	if msg.IsError {
		icon = "✗"
		nameColor = colorError
	}

	header := lipgloss.NewStyle().Foreground(nameColor).Bold(true).
		Render(fmt.Sprintf(" %s %s", icon, msg.ToolName))

	// Truncate content for display
	content := msg.Text
	lines := strings.Split(content, "\n")
	if len(lines) > 5 {
		content = strings.Join(lines[:5], "\n") + fmt.Sprintf("\n  … (%d more lines)", len(lines)-5)
	}
	// Truncate very long single lines
	contentRunes := []rune(content)
	if len(contentRunes) > 500 {
		content = string(contentRunes[:497]) + "..."
	}

	body := lipgloss.NewStyle().Foreground(colorDim).Render(content)

	return header + "\n" + body
}

// indentAfterFirst indents all lines after the first with the given prefix.
func indentAfterFirst(text, prefix string) string {
	lines := strings.Split(text, "\n")
	if len(lines) <= 1 {
		return text
	}
	for i := 1; i < len(lines); i++ {
		if lines[i] != "" {
			lines[i] = prefix + lines[i]
		}
	}
	return strings.Join(lines, "\n")
}
