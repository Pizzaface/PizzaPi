package main

import (
	"sort"

	bootstrap "github.com/pizzaface/pizzapi/experimental/adk-go/go-runner/internal/bootstrap"
	reg "github.com/pizzaface/pizzapi/experimental/adk-go/go-runner/internal/registration"
	relay "github.com/pizzaface/pizzapi/experimental/adk-go/go-runner/internal/relay"
)

type SIOClient = relay.SIOClient

type SIOClientConfig = relay.SIOClientConfig

var NewSIOClient = relay.NewSIOClient

type RelaySession = relay.RelaySession

var NewRelaySession = relay.NewRelaySession

type RunnerSkill = reg.Skill

type RunnerAgent = reg.Agent

type registrationMetadata = reg.Metadata

type sessionBootstrap = bootstrap.Session

// runnerConfig aliases the bootstrap package's RunnerConfig for use in main.go.
type runnerConfig = bootstrap.RunnerConfig

func discoverRegistrationMetadata(cwd, homeDir string) (registrationMetadata, error) {
	return reg.Discover(cwd, homeDir)
}

// resolveAgent looks up an agent by name across all compat locations and
// returns its full markdown content.  ok is false when no agent matches.
func resolveAgent(name, cwd, homeDir string) (content string, ok bool, err error) {
	return reg.ResolveAgent(name, cwd, homeDir)
}

func buildSessionBootstrap(cwd, homeDir, tempDir string) (sessionBootstrap, error) {
	return bootstrap.Build(cwd, homeDir, tempDir)
}

// loadRunnerConfig reads and merges the global and project-local PizzaPi
// config.json files, returning a RunnerConfig with hooks and sandbox settings.
func loadRunnerConfig(cwd, homeDir string) (runnerConfig, error) {
	return bootstrap.LoadConfig(cwd, homeDir)
}

// marshalHooks converts the hooks map to the wire format expected by the relay.
// Each entry becomes { "type": hookType, "matcher": matcher, "command": cmd }.
// A nil or empty map produces an empty slice (never nil) for clean JSON serialisation.
func marshalHooks(hooks map[string][]bootstrap.HookEntry) []any {
	result := make([]any, 0)
	hookTypes := make([]string, 0, len(hooks))
	for hookType := range hooks {
		hookTypes = append(hookTypes, hookType)
	}
	sort.Strings(hookTypes)
	for _, hookType := range hookTypes {
		for _, entry := range hooks[hookType] {
			for _, cmd := range entry.Hooks {
				result = append(result, map[string]any{
					"type":    hookType,
					"matcher": entry.Matcher,
					"command": cmd.Command,
				})
			}
		}
	}
	return result
}

func marshalRegistrationLists(skills []RunnerSkill, agents []RunnerAgent) ([]map[string]any, []map[string]any) {
	skillMaps := make([]map[string]any, 0, len(skills))
	for _, skill := range skills {
		skillMaps = append(skillMaps, map[string]any{"name": skill.Name, "description": skill.Description, "filePath": skill.FilePath})
	}
	agentMaps := make([]map[string]any, 0, len(agents))
	for _, agent := range agents {
		agentMaps = append(agentMaps, map[string]any{"name": agent.Name, "description": agent.Description, "filePath": agent.FilePath})
	}
	return skillMaps, agentMaps
}

func stableRoots(roots []string) []string {
	cp := append([]string(nil), roots...)
	sort.Strings(cp)
	return cp
}

func normalizeRunnerCwd(cwd string) string {
	return reg.NormalizeCWD(cwd)
}
