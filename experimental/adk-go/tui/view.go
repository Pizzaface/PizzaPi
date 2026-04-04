package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// Color palette — muted, low-noise
var (
	colorPrimary   = lipgloss.Color("#7C3AED") // purple — accent
	colorSecondary = lipgloss.Color("#10B981") // green — success/connected
	colorDim       = lipgloss.Color("#6B7280") // gray — borders, muted text
	colorText      = lipgloss.Color("#E5E7EB") // light gray — primary text
	colorError     = lipgloss.Color("#EF4444") // red — errors
	colorTool      = lipgloss.Color("#3B82F6") // blue — tool names
	colorUser      = lipgloss.Color("#F59E0B") // amber — user prompt prefix
	colorActive    = lipgloss.Color("#22D3EE") // cyan — active indicator
	colorDiffAdd   = lipgloss.Color("#22C55E") // green — diff additions
	colorDiffDel   = lipgloss.Color("#EF4444") // red — diff deletions
	colorThinking  = lipgloss.Color("#A78BFA") // light purple — thinking
)

// Styles
var (
	dimStyle  = lipgloss.NewStyle().Foreground(colorDim)
	boldStyle = lipgloss.NewStyle().Bold(true)
)

// Global renderer — initialized lazily.
var renderer *Renderer

func view(s AppState) string {
	if s.Width == 0 || s.Height == 0 {
		return "Initializing…"
	}

	// Initialize or resize renderer
	if renderer == nil {
		renderer = NewRenderer(s.Width)
	} else {
		renderer.SetWidth(s.Width)
	}

	// Layout: header(1) + messages(flex) + separator(1) + input(1) + footer(1)
	// Total chrome = 4 lines
	chromeLines := 4
	msgAreaHeight := s.Height - chromeLines
	if msgAreaHeight < 1 {
		msgAreaHeight = 1
	}

	header := renderHeader(s)
	msgArea := renderMessages(s, s.Width, msgAreaHeight)
	separator := dimStyle.Render(strings.Repeat("─", s.Width))
	inputLine := renderInput(s)
	footer := renderFooter(s, s.Width)

	return lipgloss.JoinVertical(lipgloss.Left,
		header,
		msgArea,
		separator,
		inputLine,
		footer,
	)
}

// --- Header ---

func renderHeader(s AppState) string {
	width := s.Width
	if width < 20 {
		width = 20
	}

	// Connection indicator
	connIcon := "●"
	connStyle := lipgloss.NewStyle().Foreground(colorError)
	label := "disconnected"

	if s.Connected {
		if s.Active {
			connStyle = lipgloss.NewStyle().Foreground(colorActive)
			label = "active"
			if s.IsCompacting {
				label = "compacting"
			}
			if len(s.ActiveTools) > 0 {
				var names []string
				for _, name := range s.ActiveTools {
					names = append(names, name)
				}
				toolStr := strings.Join(names, ", ")
				// Truncate tool list at narrow widths
				if width < 60 && len(toolStr) > 15 {
					toolStr = toolStr[:12] + "..."
				}
				label += " ⚡ " + toolStr
			}
		} else {
			connStyle = lipgloss.NewStyle().Foreground(colorSecondary)
			label = "idle"
		}
	}

	left := fmt.Sprintf(" %s %s", connStyle.Render(connIcon), label)

	// Right side: session name + model (omit parts at narrow widths)
	var rightParts []string
	if s.SessionName != "" && width >= 60 {
		rightParts = append(rightParts,
			lipgloss.NewStyle().Foreground(colorPrimary).Bold(true).Render(s.SessionName))
	}
	if s.ModelID != "" {
		model := s.ModelID
		// Truncate long model names at narrow widths
		if width < 80 && len(model) > 20 {
			model = model[:17] + "..."
		}
		rightParts = append(rightParts, dimStyle.Render(model))
	}
	right := strings.Join(rightParts, "  ")

	gap := width - lipgloss.Width(left) - lipgloss.Width(right) - 1
	if gap < 1 {
		gap = 1
	}

	result := left + strings.Repeat(" ", gap) + right
	// Hard truncate to width
	resultRunes := []rune(result)
	if len(resultRunes) > width {
		result = string(resultRunes[:width])
	}
	return result
}

// --- Messages ---

func renderMessages(s AppState, width, height int) string {
	var lines []string

	for _, msg := range s.Messages {
		rendered := renderer.RenderMessage(msg, width, s)

		for _, line := range strings.Split(rendered, "\n") {
			// Truncate to width
			lineRunes := []rune(line)
			if len(lineRunes) > width {
				lineRunes = lineRunes[:width]
				line = string(lineRunes)
			}
			lines = append(lines, line)
		}
	}

	// Apply scroll offset (from bottom)
	end := len(lines) - s.ScrollOffset
	if end < 0 {
		end = 0
	}
	start := end - height
	if start < 0 {
		start = 0
	}
	visible := lines[start:end]

	// Pad to fill area (push content to bottom)
	for len(visible) < height {
		visible = append([]string{""}, visible...)
	}

	return strings.Join(visible, "\n")
}

// --- Input ---

func renderInput(s AppState) string {
	prefix := lipgloss.NewStyle().Foreground(colorUser).Bold(true).Render(" ❯ ")
	// Use the textarea's view but strip its own chrome
	return prefix + s.Input.View()
}

// --- Footer ---

func renderFooter(s AppState, width int) string {
	if width < 20 {
		width = 20
	}

	// Left: cwd (truncated with ~ prefix replacement)
	cwd := s.Cwd
	if cwd == "" {
		cwd = "~"
	}

	// Right: token stats + cost + mode
	var statsParts []string

	if s.NumTurns > 0 {
		statsParts = append(statsParts, fmt.Sprintf("in:%s", formatTokens(s.InputTokens)))
		statsParts = append(statsParts, fmt.Sprintf("out:%s", formatTokens(s.OutputTokens)))
		if s.CostUSD > 0 {
			statsParts = append(statsParts, fmt.Sprintf("$%.2f", s.CostUSD))
		}
	}

	if s.Mode != "" && width >= 60 {
		statsParts = append(statsParts, "["+s.Mode+"]")
	}

	right := strings.Join(statsParts, "  ")
	if right != "" {
		right += " "
	}

	// Truncate cwd to fit: leave room for right side + minimum gap
	maxCwdWidth := width - lipgloss.Width(right) - 3
	if maxCwdWidth < 5 {
		maxCwdWidth = 5
	}
	cwdRunes := []rune(cwd)
	if len(cwdRunes) > maxCwdWidth {
		// Truncate from the left with ...
		cwd = "..." + string(cwdRunes[len(cwdRunes)-maxCwdWidth+3:])
	}
	left := " " + cwd

	gap := width - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 1 {
		gap = 1
	}

	bar := left + strings.Repeat(" ", gap) + right

	// Hard truncate
	barRunes := []rune(bar)
	if len(barRunes) > width {
		bar = string(barRunes[:width])
	}

	return dimStyle.Render(bar)
}

// --- Helpers ---

func formatTokens(count int) string {
	if count < 1000 {
		return fmt.Sprintf("%d", count)
	}
	if count < 10000 {
		return fmt.Sprintf("%.1fk", float64(count)/1000)
	}
	if count < 1000000 {
		return fmt.Sprintf("%dk", count/1000)
	}
	return fmt.Sprintf("%.1fM", float64(count)/1000000)
}
