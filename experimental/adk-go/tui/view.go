package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// Color constants
var (
	colorPrimary   = lipgloss.Color("#7C3AED") // purple
	colorSecondary = lipgloss.Color("#10B981") // green
	colorDim       = lipgloss.Color("#6B7280") // gray
	colorText      = lipgloss.Color("#E5E7EB") // light gray
	colorError     = lipgloss.Color("#EF4444") // red
	colorTool      = lipgloss.Color("#3B82F6") // blue
	colorUser      = lipgloss.Color("#F59E0B") // amber
	colorActive    = lipgloss.Color("#22D3EE") // cyan
)

// Global renderer — initialized lazily on first view with terminal width.
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

	sidebarWidth := 28
	if s.Width < 80 {
		sidebarWidth = 20
	}
	mainWidth := s.Width - sidebarWidth

	// Reserve lines: 1 header + 1 status bar
	contentHeight := s.Height - 2
	if contentHeight < 3 {
		contentHeight = 3
	}

	header := renderHeader(s)
	sidebar := renderSidebar(s, sidebarWidth, contentHeight)
	main := renderMain(s, mainWidth, contentHeight)
	statusBar := renderStatusBar(s, s.Width)

	panels := lipgloss.JoinHorizontal(lipgloss.Top, sidebar, main)
	return lipgloss.JoinVertical(lipgloss.Left, header, panels, statusBar)
}

func renderHeader(s AppState) string {
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
			// Show active tools in the header
			if len(s.ActiveTools) > 0 {
				var toolNames []string
				for _, name := range s.ActiveTools {
					toolNames = append(toolNames, name)
				}
				label += " ⚡ " + strings.Join(toolNames, ", ")
			}
		} else {
			connStyle = lipgloss.NewStyle().Foreground(colorSecondary)
			label = "connected"
		}
	}

	left := fmt.Sprintf(" %s %s", connStyle.Render(connIcon), label)

	right := ""
	if s.ModelID != "" {
		right = lipgloss.NewStyle().Foreground(colorDim).Render(s.ModelID)
	}
	if s.SessionName != "" {
		right = lipgloss.NewStyle().Foreground(colorPrimary).Bold(true).Render(s.SessionName) + "  " + right
	}

	// Pad to fill width
	gap := s.Width - lipgloss.Width(left) - lipgloss.Width(right) - 2
	if gap < 1 {
		gap = 1
	}

	return left + strings.Repeat(" ", gap) + right + " "
}

func renderSidebar(s AppState, width, height int) string {
	focused := s.ActivePanel == PanelSidebar

	title := " Sessions"
	var lines []string
	lines = append(lines, lipgloss.NewStyle().Bold(true).Foreground(colorPrimary).Render(title))

	if len(s.Sessions) == 0 {
		lines = append(lines, lipgloss.NewStyle().Foreground(colorDim).Render(" No sessions"))
	} else {
		for _, sess := range s.Sessions {
			name := sess.Name
			if name == "" {
				name = ShortID(sess.ID)
			}
			nameRunes := []rune(name)
			if len(nameRunes) > width-4 {
				nameRunes = nameRunes[:width-4]
				name = string(nameRunes)
			}

			icon := " "
			if sess.Active {
				icon = "●"
			}

			style := lipgloss.NewStyle().Width(width)
			if sess.ID == s.ActiveSessionID {
				style = style.Background(lipgloss.Color("#374151")).Bold(true)
			}
			lines = append(lines, style.Render(fmt.Sprintf(" %s %s", icon, name)))
		}
	}

	// Pad to height
	for len(lines) < height {
		lines = append(lines, "")
	}
	if len(lines) > height {
		lines = lines[:height]
	}

	content := strings.Join(lines, "\n")

	borderColor := colorDim
	if focused {
		borderColor = colorPrimary
	}

	return lipgloss.NewStyle().
		Width(width).
		Height(height).
		BorderStyle(lipgloss.RoundedBorder()).
		BorderRight(true).
		BorderForeground(borderColor).
		Render(content)
}

func renderMain(s AppState, width, height int) string {
	focused := s.ActivePanel == PanelMain

	// Reserve 3 lines for input area
	msgAreaHeight := height - 3
	if msgAreaHeight < 1 {
		msgAreaHeight = 1
	}

	// Render message lines
	var msgLines []string
	for _, msg := range s.Messages {
		rendered := renderer.RenderMessage(msg, width)

		// Split into lines and truncate to width
		for _, line := range strings.Split(rendered, "\n") {
			lineRunes := []rune(line)
			if len(lineRunes) > width-2 {
				lineRunes = lineRunes[:width-2]
				line = string(lineRunes)
			}
			msgLines = append(msgLines, line)
		}
	}

	// Apply scroll offset (from bottom)
	end := len(msgLines) - s.ScrollOffset
	if end < 0 {
		end = 0
	}
	start := end - msgAreaHeight
	if start < 0 {
		start = 0
	}
	visible := msgLines[start:end]

	// Pad to fill area
	for len(visible) < msgAreaHeight {
		visible = append([]string{""}, visible...)
	}

	msgArea := strings.Join(visible, "\n")

	// Input area
	inputLine := s.Input.View()

	borderColor := colorDim
	if focused {
		borderColor = colorPrimary
	}

	content := msgArea + "\n" + strings.Repeat("─", width-2) + "\n" + inputLine

	return lipgloss.NewStyle().
		Width(width).
		Height(height).
		BorderStyle(lipgloss.RoundedBorder()).
		BorderLeft(true).
		BorderForeground(borderColor).
		Render(content)
}

func renderStatusBar(s AppState, width int) string {
	modeLabel := ""
	if s.Mode != "" {
		modeLabel = "[" + s.Mode + "] "
	}
	left := " " + modeLabel + "tab: panel  ↑↓: scroll  enter: send  ctrl+c: quit"
	right := ""

	if s.NumTurns > 0 {
		right = fmt.Sprintf("turns:%d  in:%d out:%d  $%.4f ",
			s.NumTurns, s.InputTokens, s.OutputTokens, s.CostUSD)
	}

	gap := width - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 1 {
		gap = 1
	}

	bar := left + strings.Repeat(" ", gap) + right

	// Truncate
	runes := []rune(bar)
	if len(runes) > width {
		runes = runes[:width]
		bar = string(runes)
	}

	return lipgloss.NewStyle().
		Width(width).
		Foreground(colorDim).
		Render(bar)
}

// ShortID returns the first 8 characters of s for display.
func ShortID(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	return s
}
