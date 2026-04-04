package registration

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/pizzaface/pizzapi/experimental/adk-go/runtime/compat"
)

type Skill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	FilePath    string `json:"filePath"`
}

type Agent struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	FilePath    string `json:"filePath"`
}

type Metadata struct {
	Roots  []string
	Skills []Skill
	Agents []Agent
}

// Discover collects all skills and agents discoverable from cwd and homeDir,
// building a Metadata payload ready for registration.
func Discover(cwd, homeDir string) (Metadata, error) {
	locator := compat.NewLocator(homeDir, cwd)
	skills, err := locator.DiscoverSkills()
	if err != nil {
		return Metadata{}, err
	}
	agents, err := locator.DiscoverAgents()
	if err != nil {
		return Metadata{}, err
	}

	meta := Metadata{Roots: []string{cwd}}
	for _, skill := range skills {
		meta.Skills = append(meta.Skills, Skill{
			Name:        skill.Name,
			Description: resourceDescription(skill.Path, skill.Name),
			FilePath:    skill.Path,
		})
	}
	for _, agent := range agents {
		meta.Agents = append(meta.Agents, Agent{
			Name:        agent.Name,
			Description: resourceDescription(agent.Path, agent.Name),
			FilePath:    agent.Path,
		})
	}
	return meta, nil
}

// ResolveAgent looks up an agent by name across all compat locations (project then
// global) and returns the full file contents. ok is false when no agent by that
// name exists; an error is only returned when discovery or file-reading fails.
func ResolveAgent(name, cwd, homeDir string) (content string, ok bool, err error) {
	locator := compat.NewLocator(homeDir, cwd)
	agents, err := locator.DiscoverAgents()
	if err != nil {
		return "", false, err
	}
	for _, agent := range agents {
		if agent.Name == name {
			data, err := os.ReadFile(agent.Path)
			if err != nil {
				return "", false, err
			}
			return string(data), true, nil
		}
	}
	return "", false, nil
}

// resourceDescription returns the description for a skill or agent file.
// It first tries to extract a description from YAML frontmatter; if none is
// found it falls back to the first non-empty, non-heading line of the file.
func resourceDescription(path, fallback string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return fallback
	}
	text := string(data)
	if desc := frontmatterDescription(text); desc != "" {
		return desc
	}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || line == "---" {
			continue
		}
		return line
	}
	return fallback
}

// frontmatterDescription extracts the value of the "description" key from a
// YAML frontmatter block (delimited by leading and trailing "---" lines).
//
// It handles the following value styles found in real agent/skill files:
//   - Plain scalar:       description: some text
//   - Double-quoted:      description: "some text"
//   - Single-quoted:      description: 'some text'
//   - Block literal (|):  multi-line joined with a space
//   - Block folded (>):   multi-line joined with a space
//
// The key comparison is case-insensitive. An empty string is returned when
// the document has no frontmatter or no description key.
func frontmatterDescription(text string) string {
	// Normalize CRLF to LF so Windows-style line endings don't bypass the check.
	text = strings.ReplaceAll(text, "\r\n", "\n")

	// Frontmatter must start at byte 0 with "---\n".
	if !strings.HasPrefix(text, "---\n") {
		return ""
	}

	lines := strings.Split(text, "\n")

	// Find the closing "---" (or "...") delimiter.
	endLine := -1
	for i := 1; i < len(lines); i++ {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "---" || trimmed == "..." {
			endLine = i
			break
		}
	}
	if endLine < 0 {
		return "" // no closing delimiter — not valid frontmatter
	}

	fmLines := lines[1:endLine]

	for i := 0; i < len(fmLines); i++ {
		line := fmLines[i]

		// Skip empty lines and comment lines.
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}

		colonIdx := strings.Index(line, ":")
		if colonIdx < 0 {
			continue
		}

		key := strings.TrimSpace(line[:colonIdx])
		if !strings.EqualFold(key, "description") {
			continue
		}

		// Everything after the colon is the raw value fragment.
		raw := strings.TrimSpace(line[colonIdx+1:])

		// Block scalar indicators.
		switch raw {
		case "|", "|-", "|+", ">", ">-", ">+":
			return collectBlockScalar(fmLines[i+1:])
		}

		// Double-quoted string.
		if strings.HasPrefix(raw, `"`) {
			return parseDoubleQuoted(raw)
		}

		// Single-quoted string.
		if strings.HasPrefix(raw, `'`) {
			return parseSingleQuoted(raw)
		}

		// Plain scalar — strip inline comment (space + #).
		if idx := strings.Index(raw, " #"); idx >= 0 {
			raw = strings.TrimSpace(raw[:idx])
		}
		return raw
	}

	return ""
}

// collectBlockScalar gathers indented lines that form the body of a YAML block
// scalar and joins them with spaces (we don't distinguish | from > here —
// both are collapsed to a single-line description).
func collectBlockScalar(remaining []string) string {
	var parts []string
	for _, line := range remaining {
		// Block content is indented; a non-indented line ends the block.
		if line == "" {
			// Blank lines inside the block are preserved as spaces.
			parts = append(parts, "")
			continue
		}
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
			break
		}
		parts = append(parts, strings.TrimSpace(line))
	}
	// Trim trailing blank entries.
	for len(parts) > 0 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	return strings.Join(parts, " ")
}

// parseDoubleQuoted extracts the content of a double-quoted YAML scalar,
// handling \" escape sequences. The leading '"' must be included in raw.
func parseDoubleQuoted(raw string) string {
	s := raw[1:] // strip leading "
	var sb strings.Builder
	i := 0
	for i < len(s) {
		ch := s[i]
		if ch == '"' {
			break
		}
		if ch == '\\' && i+1 < len(s) {
			next := s[i+1]
			switch next {
			case '"':
				sb.WriteByte('"')
			case '\\':
				sb.WriteByte('\\')
			case 'n':
				sb.WriteByte('\n')
			case 't':
				sb.WriteByte('\t')
			default:
				sb.WriteByte('\\')
				sb.WriteByte(next)
			}
			i += 2
			continue
		}
		sb.WriteByte(ch)
		i++
	}
	return sb.String()
}

// parseSingleQuoted extracts the content of a single-quoted YAML scalar.
// In YAML single-quoted scalars, ” is the only escape sequence (for a
// literal single quote). The leading "'" must be included in raw.
func parseSingleQuoted(raw string) string {
	s := raw[1:] // strip leading '
	var sb strings.Builder
	i := 0
	for i < len(s) {
		ch := s[i]
		if ch == '\'' {
			// '' is an escaped single quote; a lone ' is the closing delimiter.
			if i+1 < len(s) && s[i+1] == '\'' {
				sb.WriteByte('\'')
				i += 2
				continue
			}
			break
		}
		sb.WriteByte(ch)
		i++
	}
	return sb.String()
}

// NormalizeCWD returns a clean absolute working directory path, defaulting to
// os.Getwd() when cwd is empty.
func NormalizeCWD(cwd string) string {
	if cwd == "" {
		if wd, err := os.Getwd(); err == nil {
			return wd
		}
	}
	return filepath.Clean(cwd)
}
