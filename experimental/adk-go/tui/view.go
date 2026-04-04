package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// ── colour palette ──────────────────────────────────────────────────────────

var (
	colorBorder       = lipgloss.Color("240")
	colorActiveBorder = lipgloss.Color("63")
	colorHeader       = lipgloss.Color("212")
	colorSelected     = lipgloss.Color("63")
	colorDim          = lipgloss.Color("240")
	colorText         = lipgloss.Color("252")
)

// ── style helpers ────────────────────────────────────────────────────────────

func panelBorder(focused bool) lipgloss.Style {
	borderColor := colorBorder
	if focused {
		borderColor = colorActiveBorder
	}
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(borderColor)
}

// ── view ─────────────────────────────────────────────────────────────────────

// view renders the full TUI from the given AppState.
func view(s AppState) string {
	if s.Width == 0 {
		return "Loading…"
	}

	// Reserve 2 columns for outer padding/border; lipgloss counts inner content.
	// Sidebar takes ~25% of terminal width; main takes the rest.
	sidebarWidth := s.Width / 4
	if sidebarWidth < 20 {
		sidebarWidth = 20
	}
	// +2 for border chars on each side
	mainWidth := s.Width - sidebarWidth - 4
	if mainWidth < 10 {
		mainWidth = 10
	}
	// Reserve 1 line for the status bar at the very bottom.
	// Header + bottom input + border + status bar take ~6 lines.
	contentHeight := s.Height - 5
	if contentHeight < 3 {
		contentHeight = 3
	}
	msgAreaHeight := contentHeight - 3 // minus input row + separator
	if msgAreaHeight < 1 {
		msgAreaHeight = 1
	}

	sidebar := renderSidebar(s, sidebarWidth, contentHeight)
	main := renderMain(s, mainWidth, contentHeight, msgAreaHeight)
	statusBar := renderStatusBar(s, s.Width)

	panels := lipgloss.JoinHorizontal(lipgloss.Top, sidebar, main)
	return lipgloss.JoinVertical(lipgloss.Left, panels, statusBar)
}

// renderSidebar renders the left panel with a session list.
func renderSidebar(s AppState, width, height int) string {
	focused := s.ActivePanel == PanelSidebar

	headerStyle := lipgloss.NewStyle().
		Foreground(colorHeader).
		Bold(true).
		Width(width).
		Align(lipgloss.Left)

	header := headerStyle.Render("Sessions")

	var rows []string
	rows = append(rows, header)
	rows = append(rows, lipgloss.NewStyle().Foreground(colorDim).Render(strings.Repeat("─", width)))

	for _, sess := range s.Sessions {
		name := sess.Name
		// Use rune slicing to avoid splitting multi-byte codepoints.
		nameRunes := []rune(name)
		if len(nameRunes) > width-2 {
			nameRunes = nameRunes[:width-2]
			name = string(nameRunes)
		}

		rowStyle := lipgloss.NewStyle().Width(width)
		if sess.ID == s.ActiveSessionID {
			rowStyle = rowStyle.
				Foreground(colorSelected).
				Bold(true)
			name = "▶ " + name
		} else {
			rowStyle = rowStyle.Foreground(colorText)
			name = "  " + name
		}
		rows = append(rows, rowStyle.Render(name))
	}

	// Pad to fill height.
	for len(rows) < height-2 {
		rows = append(rows, "")
	}

	inner := strings.Join(rows, "\n")

	return panelBorder(focused).
		Width(width).
		Height(height).
		Render(inner)
}

// renderStatusBar renders a one-line help legend at the bottom of the screen.
func renderStatusBar(_ AppState, width int) string {
	legend := " tab: switch panel  |  ↑↓: scroll  |  enter: send  |  ctrl+c: quit  |  q: quit (sidebar)"
	// Truncate to terminal width using rune slicing.
	runes := []rune(legend)
	if len(runes) > width {
		runes = runes[:width]
		legend = string(runes)
	}
	return lipgloss.NewStyle().
		Width(width).
		Foreground(colorDim).
		Render(legend)
}

// renderMain renders the right panel with the message stream and input field.
func renderMain(s AppState, width, height, msgAreaHeight int) string {
	focused := s.ActivePanel == PanelMain

	// ── message area ──────────────────────────────────────────────────────────

	// Apply scroll: show the last N visible lines minus scroll offset.
	msgs := s.Messages
	start := len(msgs) - msgAreaHeight - s.ScrollOffset
	if start < 0 {
		start = 0
	}
	end := start + msgAreaHeight
	if end > len(msgs) {
		end = len(msgs)
	}
	visible := msgs[start:end]

	msgLines := make([]string, msgAreaHeight)
	for i := range msgLines {
		idx := i - (msgAreaHeight - len(visible))
		if idx >= 0 && idx < len(visible) {
			line := visible[idx]
			// Use rune slicing to avoid splitting multi-byte codepoints.
			lineRunes := []rune(line)
			if len(lineRunes) > width {
				lineRunes = lineRunes[:width]
				line = string(lineRunes)
			}
			msgLines[i] = lipgloss.NewStyle().Foreground(colorText).Render(line)
		}
	}

	msgArea := strings.Join(msgLines, "\n")

	// ── separator ─────────────────────────────────────────────────────────────
	sep := lipgloss.NewStyle().Foreground(colorDim).Render(strings.Repeat("─", width))

	// ── input area ────────────────────────────────────────────────────────────
	scrollHint := ""
	if s.ScrollOffset > 0 {
		scrollHint = fmt.Sprintf(" [↑%d]", s.ScrollOffset)
	}
	inputLine := s.Input.View() + lipgloss.NewStyle().Foreground(colorDim).Render(scrollHint)

	inner := strings.Join([]string{msgArea, sep, inputLine}, "\n")

	return panelBorder(focused).
		Width(width).
		Height(height).
		Render(inner)
}
