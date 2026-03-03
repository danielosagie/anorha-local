//go:build windows || darwin

package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ollama/ollama/app/agentruntime"
)

func TestBrowserUseExecuteSuccess(t *testing.T) {
	type optionsReq struct {
		ThreadID string                      `json:"threadId"`
		Options  agentruntime.RuntimeOptions `json:"options"`
	}
	type runReq struct {
		ThreadID string `json:"threadId"`
		Message  string `json:"message"`
		StartURL string `json:"startUrl"`
	}

	var gotOptions optionsReq
	var gotRun runReq

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/options":
			defer r.Body.Close()
			if err := json.NewDecoder(r.Body).Decode(&gotOptions); err != nil {
				t.Fatalf("decode options request: %v", err)
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"success":true}`))
		case "/v1/run":
			defer r.Body.Close()
			if err := json.NewDecoder(r.Body).Decode(&gotRun); err != nil {
				t.Fatalf("decode run request: %v", err)
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"success":true,"summary":"done","data":{"x":1}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	tool := NewBrowserUse(
		agentruntime.NewClient(srv.URL),
		"thread-1",
		agentruntime.ProviderRouteLocalOllama,
		"qwen3:8b",
	)

	result, summary, err := tool.Execute(context.Background(), map[string]any{
		"task":      "find docs",
		"start_url": "https://example.com",
	})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if summary != "done" {
		t.Fatalf("summary = %q, want %q", summary, "done")
	}
	if gotOptions.ThreadID != "thread-1" {
		t.Fatalf("options thread id = %q", gotOptions.ThreadID)
	}
	if gotOptions.Options.RuntimeBackend != agentruntime.RuntimeBackendBrowserUse {
		t.Fatalf("runtime backend = %q", gotOptions.Options.RuntimeBackend)
	}
	if gotRun.Message != "find docs" {
		t.Fatalf("run message = %q", gotRun.Message)
	}
	if gotRun.StartURL != "https://example.com" {
		t.Fatalf("run start url = %q", gotRun.StartURL)
	}

	payload, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("result type = %T, want map[string]any", result)
	}
	if payload["summary"] != "done" {
		t.Fatalf("result summary = %v", payload["summary"])
	}
}

func TestBrowserUseExecuteRequiresTask(t *testing.T) {
	tool := NewBrowserUse(nil, "thread-1", agentruntime.ProviderRouteLocalOllama, "")
	_, _, err := tool.Execute(context.Background(), map[string]any{})
	if err == nil {
		t.Fatal("expected error for missing runtime/task")
	}
}
