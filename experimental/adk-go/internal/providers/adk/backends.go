package adk

import (
	"context"

	"google.golang.org/genai"

	"google.golang.org/adk/model"
	"google.golang.org/adk/model/gemini"
)

// GeminiBackend returns the BackendConfig for Google Gemini models.
func GeminiBackend() BackendConfig {
	return BackendConfig{
		Name:           "gemini",
		Provider:       "google",
		DefaultModel:   "gemini-2.5-flash",
		APIKeyEnvVar:   "GOOGLE_API_KEY",
		AuthProviderID: "google-gemini-cli",
		NewModel: func(ctx context.Context, modelName, apiKey string) (model.LLM, error) {
			return gemini.NewModel(ctx, modelName, &genai.ClientConfig{
				APIKey: apiKey,
			})
		},
	}
}

// AllBackends returns all ADK-backed backend configurations.
// OpenAI is handled separately (internal/providers/openai/) since it uses
// the OpenAI API directly rather than ADK's model abstraction.
func AllBackends() []BackendConfig {
	return []BackendConfig{
		GeminiBackend(),
	}
}
