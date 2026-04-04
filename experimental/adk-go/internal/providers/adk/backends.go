package adk

import (
	"context"
	"fmt"

	"google.golang.org/genai"

	"google.golang.org/adk/model"
	"google.golang.org/adk/model/gemini"
)

// GeminiBackend returns the BackendConfig for Google Gemini models.
func GeminiBackend() BackendConfig {
	return BackendConfig{
		Name:         "gemini",
		Provider:     "google",
		DefaultModel: "gemini-2.5-flash",
		APIKeyEnvVar: "GOOGLE_API_KEY",
		NewModel: func(ctx context.Context, modelName, apiKey string) (model.LLM, error) {
			return gemini.NewModel(ctx, modelName, &genai.ClientConfig{
				APIKey: apiKey,
			})
		},
	}
}

// OpenAIBackend returns the BackendConfig for OpenAI-compatible models.
// Uses the genai SDK's OpenAI-compatible endpoint support.
func OpenAIBackend() BackendConfig {
	return BackendConfig{
		Name:         "openai",
		Provider:     "openai",
		DefaultModel: "gpt-4o",
		APIKeyEnvVar: "OPENAI_API_KEY",
		NewModel: func(ctx context.Context, modelName, apiKey string) (model.LLM, error) {
			// The genai SDK supports OpenAI-compatible endpoints via Backend config.
			// For now, we use Gemini's model constructor with OpenAI backend.
			// TODO: Once ADK Go adds native OpenAI model support, switch to that.
			return nil, fmt.Errorf("openai backend not yet implemented — waiting for ADK Go native OpenAI support")
		},
	}
}

// AllBackends returns all supported backend configurations.
func AllBackends() []BackendConfig {
	return []BackendConfig{
		GeminiBackend(),
		// OpenAIBackend() — uncomment when ADK Go adds OpenAI model support
	}
}
