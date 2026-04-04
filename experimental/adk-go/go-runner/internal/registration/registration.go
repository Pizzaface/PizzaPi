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

func frontmatterDescription(text string) string {
	if !strings.HasPrefix(text, "---\n") {
		return ""
	}
	lines := strings.Split(text, "\n")
	for i := 1; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if line == "---" {
			break
		}
		if strings.HasPrefix(strings.ToLower(line), "description:") {
			return strings.TrimSpace(strings.Trim(strings.TrimPrefix(line, "description:"), `"'`))
		}
	}
	return ""
}

func NormalizeCWD(cwd string) string {
	if cwd == "" {
		if wd, err := os.Getwd(); err == nil {
			return wd
		}
	}
	return filepath.Clean(cwd)
}
