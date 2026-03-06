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
		resolvedParts, _, err := resolveRuntimeCommand(m.logger)
		if err != nil {
			return err
		}
		parts = resolvedParts
	}

	cmd := exec.CommandContext(context.Background(), parts[0], parts[1:]...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	runtimeSource, resourcesDir, bundledRuntimeDir, bundledBrowserDir := detectRuntimeEnvironment()
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
		"BROWSER_USE_RUNTIME_SOURCE="+runtimeSource,
	)
	if resourcesDir != "" {
		cmd.Env = append(cmd.Env, "ANORHA_APP_RESOURCES_DIR="+resourcesDir)
	}
	if bundledRuntimeDir != "" {
		cmd.Env = append(cmd.Env, "BROWSER_USE_BUNDLED_RUNTIME_DIR="+bundledRuntimeDir)
	}
	if bundledBrowserDir != "" {
		cmd.Env = append(cmd.Env, "BROWSER_USE_BUNDLED_BROWSER_DIR="+bundledBrowserDir)
		cmd.Env = append(cmd.Env, "PLAYWRIGHT_BROWSERS_PATH="+bundledBrowserDir)
	}

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

func resolveRuntimeCommand(logger *slog.Logger) ([]string, string, error) {
	runtimeSource, resourcesDir, _, _ := detectRuntimeEnvironment()
	node := "node"
	if runtime.GOOS == "windows" {
		node = "node.exe"
	}

	if resourcesDir != "" {
		bundledNode := filepath.Join(resourcesDir, node)
		bundledRuntime := filepath.Join(resourcesDir, "agent-runtime", "dist", "server.js")
		if runtime.GOOS == "windows" {
			bundledNode = filepath.Join(resourcesDir, "node.exe")
		}
		if fileExists(bundledNode) && fileExists(bundledRuntime) {
			return []string{bundledNode, bundledRuntime}, runtimeSource, nil
		}
	}

	runtimePath := filepath.Join("app", "agent-runtime", "dist", "server.js")
	if fileExists(runtimePath) {
		return []string{node, runtimePath}, "dev-external", nil
	}

	srcPath := filepath.Join("app", "agent-runtime", "src", "server.ts")
	if !fileExists(srcPath) {
		return nil, runtimeSource, fmt.Errorf("agent runtime entrypoint is missing (checked %s and %s)", runtimePath, srcPath)
	}
	logger.Warn("agent runtime dist bundle missing; falling back to source mode", "src", srcPath)
	return []string{node, "--experimental-strip-types", srcPath}, "dev-external", nil
}

func detectRuntimeEnvironment() (string, string, string, string) {
	if explicit := strings.TrimSpace(os.Getenv("BROWSER_USE_RUNTIME_SOURCE")); explicit != "" {
		resourcesDir := resolveResourcesDir()
		return explicit, resourcesDir, detectBundledDir(resourcesDir, "browser-use-runtime"), detectBundledDir(resourcesDir, "browser-use-browsers")
	}

	resourcesDir := resolveResourcesDir()
	if resourcesDir == "" {
		return "dev-external", "", "", ""
	}

	source := "dev-external"
	switch runtime.GOOS {
	case "darwin":
		source = "bundled-macos"
	case "windows":
		source = "bundled-windows"
	}
	return source, resourcesDir, detectBundledDir(resourcesDir, "browser-use-runtime"), detectBundledDir(resourcesDir, "browser-use-browsers")
}

func resolveResourcesDir() string {
	if explicit := strings.TrimSpace(os.Getenv("ANORHA_APP_RESOURCES_DIR")); explicit != "" && fileExists(explicit) {
		return explicit
	}

	exePath, err := os.Executable()
	if err != nil {
		return ""
	}
	exeDir := filepath.Dir(exePath)
	switch runtime.GOOS {
	case "darwin":
		candidate := filepath.Clean(filepath.Join(exeDir, "..", "Resources"))
		if fileExists(candidate) {
			return candidate
		}
	case "windows":
		if fileExists(exeDir) {
			return exeDir
		}
	}
	return ""
}

func detectBundledDir(resourcesDir string, name string) string {
	if resourcesDir == "" {
		return ""
	}
	candidate := filepath.Join(resourcesDir, name)
	if fileExists(candidate) {
		return candidate
	}
	return ""
}

func fileExists(target string) bool {
	if target == "" {
		return false
	}
	_, err := os.Stat(target)
	return err == nil
}

func (m *SidecarManager) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cmd != nil && m.cmd.Process != nil {
		_ = m.cmd.Process.Kill()
		m.cmd = nil
	}
}
