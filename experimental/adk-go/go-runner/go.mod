module github.com/pizzaface/pizzapi/experimental/adk-go/go-runner

go 1.22

require (
	github.com/gorilla/websocket v1.5.3
	github.com/pizzaface/pizzapi/experimental/adk-go/claude-wrapper v0.0.0
)

replace github.com/pizzaface/pizzapi/experimental/adk-go/claude-wrapper => ../claude-wrapper
