//go:build windows || darwin

package agentruntime

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type SidecarManager struct {
	baseURL string
	client  *Client
	cmd     *exec.Cmd
	mu      sync.Mutex
	logger  *slog.Logger
}

func NewSidecarManager(baseURL string, logger *slog.Logger) *SidecarManager {
	if baseURL == "" {
		host := strings.TrimSpace(os.Getenv("ANORHA_RUNTIME_HOST"))
		if host == "" {
			host = "127.0.0.1"
		}
		port := strings.TrimSpace(os.Getenv("ANORHA_RUNTIME_PORT"))
		if port == "" {
			port = "7318"
		}
		baseURL = fmt.Sprintf("http://%s:%s", host, port)
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &SidecarManager{
		baseURL: strings.TrimRight(baseURL, "/"),
		client:  NewClient(baseURL),
		logger:  logger,
	}
}

func (m *SidecarManager) BaseURL() string {
	return m.baseURL
}

func (m *SidecarManager) Client() *Client {
	return m.client
}

func (m *SidecarManager) EnsureRunning(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	healthCtx, cancel := context.WithTimeout(ctx, 1*time.Second)
	defer cancel()
	if err := m.client.Health(healthCtx); err == nil {
		return nil
	}

	if m.cmd != nil && m.cmd.Process != nil {
		_ = m.cmd.Process.Kill()
		m.cmd = nil
	}

	parts := strings.Fields(strings.TrimSpace(os.Getenv("ANORHA_RUNTIME_CMD")))
	if len(parts) == 0 {
		node := "node"
		if runtime.GOOS == "windows" {
			node = "node.exe"
		}

		runtimePath := filepath.Join("app", "agent-runtime", "dist", "server.js")
		if _, err := os.Stat(runtimePath); err == nil {
			parts = []string{node, runtimePath}
		} else {
			srcPath := filepath.Join("app", "agent-runtime", "src", "server.ts")
			if _, srcErr := os.Stat(srcPath); srcErr != nil {
				return fmt.Errorf("agent runtime entrypoint is missing (checked %s and %s)", runtimePath, srcPath)
			}
			// Fall back to source mode for local development when dist isn't built.
			// Node v25 in this environment supports TS strip mode.
			parts = []string{node, "--experimental-strip-types", srcPath}
			m.logger.Warn("agent runtime dist bundle missing; falling back to source mode", "src", srcPath)
		}
	}

	cmd := exec.CommandContext(context.Background(), parts[0], parts[1:]...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	runtimeHost := strings.TrimSpace(os.Getenv("ANORHA_RUNTIME_HOST"))
	if runtimeHost == "" {
		runtimeHost = "127.0.0.1"
	}
	runtimePort := strings.TrimSpace(os.Getenv("ANORHA_RUNTIME_PORT"))
	if runtimePort == "" {
		runtimePort = "7318"
	}
	cmd.Env = append(os.Environ(),
		"ANORHA_RUNTIME_PORT="+runtimePort,
		"ANORHA_RUNTIME_HOST="+runtimeHost,
	)

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start agent runtime: %w", err)
	}

	m.cmd = cmd
	m.logger.Info("started agent runtime sidecar", "pid", cmd.Process.Pid, "cmd", strings.Join(parts, " "))

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		hCtx, hCancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		err := m.client.Health(hCtx)
		hCancel()
		if err == nil {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}

	return fmt.Errorf("agent runtime sidecar failed healthcheck startup")
}

func (m *SidecarManager) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cmd != nil && m.cmd.Process != nil {
		_ = m.cmd.Process.Kill()
		m.cmd = nil
	}
}
