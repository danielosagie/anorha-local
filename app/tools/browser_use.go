//go:build windows || darwin

package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/ollama/ollama/app/agentruntime"
)

// BrowserUse exposes Browser-Use MCP as a single callable local tool.
type BrowserUse struct {
	runtime       *agentruntime.Client
	threadID      string
	providerRoute agentruntime.ProviderRoute
	providerModel string
}

func NewBrowserUse(runtime *agentruntime.Client, threadID string, route agentruntime.ProviderRoute, providerModel string) *BrowserUse {
	if route == "" {
		route = agentruntime.ProviderRouteLocalOllama
	}
	return &BrowserUse{
		runtime:       runtime,
		threadID:      threadID,
		providerRoute: route,
		providerModel: providerModel,
	}
}

func (b *BrowserUse) Name() string {
	return "browser_use"
}

func (b *BrowserUse) Description() string {
	return "Use a local Browser-Use MCP browser agent to complete a web task"
}

func (b *BrowserUse) Prompt() string {
	return ""
}

func (b *BrowserUse) Schema() map[string]any {
	schemaBytes := []byte(`{
		"type": "object",
		"properties": {
			"task": {
				"type": "string",
				"description": "The browser task to perform"
			},
			"start_url": {
				"type": "string",
				"description": "Optional URL to open before running the task"
			}
		},
		"required": ["task"]
	}`)
	var schema map[string]any
	if err := json.Unmarshal(schemaBytes, &schema); err != nil {
		return nil
	}
	return schema
}

func (b *BrowserUse) Execute(ctx context.Context, args map[string]any) (any, string, error) {
	if b.runtime == nil {
		return nil, "", fmt.Errorf("browser_use runtime is unavailable; ensure the local runtime sidecar is running")
	}

	task := firstNonEmptyString(args, "task", "prompt", "query", "instruction", "input")
	if task == "" {
		return nil, "", fmt.Errorf("task parameter is required")
	}

	startURL := firstNonEmptyString(args, "start_url", "startUrl", "url")

	options := agentruntime.RuntimeOptions{
		BrowserControlEnabled: true,
		Headless:              false,
		WebToolsEnabled:       true,
		RuntimeBackend:        agentruntime.RuntimeBackendBrowserUse,
		RecordingEnabled:      false,
		ControlBorderEnabled:  false,
		ProviderRoute:         b.providerRoute,
		ProviderModel:         b.providerModel,
		EscalationEligible:    false,
		VerificationRuns:      1,
	}

	if err := b.runtime.SetOptions(ctx, b.threadID, options); err != nil {
		return nil, "", fmt.Errorf("failed to configure browser_use runtime: %w", err)
	}

	result, err := b.runtime.Run(ctx, agentruntime.RunPayload{
		ThreadID: b.threadID,
		Message:  task,
		StartURL: startURL,
		Options:  options,
	})
	if err != nil {
		return nil, "", fmt.Errorf("browser_use failed: %w", err)
	}
	if result == nil || !result.Success {
		msg := "browser_use runtime returned an unsuccessful result"
		if result != nil && strings.TrimSpace(result.Error) != "" {
			msg = strings.TrimSpace(result.Error)
		}
		return nil, "", fmt.Errorf("browser_use failed: %s", msg)
	}

	summary := strings.TrimSpace(result.Summary)
	if summary == "" {
		summary = "Browser task completed."
	}

	payload := map[string]any{
		"success": true,
		"summary": summary,
	}
	if result.Data != nil {
		payload["data"] = result.Data
	}

	return payload, summary, nil
}

func firstNonEmptyString(args map[string]any, keys ...string) string {
	for _, key := range keys {
		value, ok := args[key]
		if !ok {
			continue
		}
		if s, ok := value.(string); ok {
			s = strings.TrimSpace(s)
			if s != "" {
				return s
			}
		}
	}
	return ""
}
