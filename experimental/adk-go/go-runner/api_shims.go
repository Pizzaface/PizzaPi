package main

import (
	"log"
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

func discoverRegistrationMetadata(cwd, homeDir string) (registrationMetadata, error) {
	return reg.Discover(cwd, homeDir)
}

func buildSessionBootstrap(cwd, homeDir, tempDir string) (sessionBootstrap, error) {
	return bootstrap.Build(cwd, homeDir, tempDir)
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

func newDefaultProviderFactory() func(*log.Logger) Provider {
	return func(logger *log.Logger) Provider { return NewClaudeCLIProvider(logger) }
}
