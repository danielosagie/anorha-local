//go:build windows || darwin

package agentruntime

type RuntimeBackend string

type ProviderRoute string
type WorkflowOperation string
type ViewportProfile string

const (
	RuntimeBackendBrowserUse RuntimeBackend = "browser_use_ts"
	RuntimeBackendPlaywright RuntimeBackend = "playwright_direct"
	RuntimeBackendAttached   RuntimeBackend = "playwright_attached"
	ProviderRouteLocalOllama ProviderRoute  = "local_ollama"
	ProviderRouteOllamaCloud ProviderRoute  = "ollama_cloud"
	ProviderRouteKimi        ProviderRoute  = "kimi"
	ProviderRouteOpenRouter  ProviderRoute  = "openrouter"
	WorkflowOperationCreate  WorkflowOperation = "create"
	WorkflowOperationRead    WorkflowOperation = "read"
	WorkflowOperationUpdate  WorkflowOperation = "update"
	WorkflowOperationDelete  WorkflowOperation = "delete"
	ViewportDesktop          ViewportProfile   = "desktop"
	ViewportTablet           ViewportProfile   = "tablet"
	ViewportMobile           ViewportProfile   = "mobile"
)

type RuntimeOptions struct {
	BrowserControlEnabled bool           `json:"browserControlEnabled"`
	Headless              bool           `json:"headless"`
	WebToolsEnabled       bool           `json:"webToolsEnabled"`
	RuntimeBackend        RuntimeBackend `json:"runtimeBackend"`
	AllowAttachedFallback bool           `json:"allowAttachedFallback,omitempty"`
	RuntimeSpeed          string         `json:"runtimeSpeed,omitempty"`
	RuntimeCDPURL         string         `json:"runtimeCDPURL,omitempty"`
	RuntimeTabIndex       int            `json:"runtimeTabIndex,omitempty"`
	RuntimeTabMatch       string         `json:"runtimeTabMatch,omitempty"`
	RuntimeTabPolicy      string         `json:"runtimeTabPolicy,omitempty"`
	RuntimeMaxSteps       int            `json:"runtimeMaxSteps,omitempty"`
	RecordingEnabled      bool           `json:"recordingEnabled"`
	ControlBorderEnabled  bool           `json:"controlBorderEnabled"`
	ProviderRoute         ProviderRoute  `json:"providerRoute"`
	ProviderModel         string         `json:"providerModel,omitempty"`
	EscalationEligible    bool           `json:"escalationEligible"`
	VerificationRuns      int            `json:"verificationRuns"`
}

type RunPayload struct {
	ThreadID          string            `json:"threadId"`
	Message           string            `json:"message"`
	StartURL          string            `json:"startUrl,omitempty"`
	Options           RuntimeOptions    `json:"options"`
	WorkflowRunID     string            `json:"workflowRunId,omitempty"`
	WorkflowItemID    string            `json:"workflowItemId,omitempty"`
	WorkflowKey       string            `json:"workflowKey,omitempty"`
	WorkflowOperation WorkflowOperation `json:"workflowOperation,omitempty"`
	WorkflowStagePlan []string          `json:"workflowStagePlan,omitempty"`
	WorkflowInput     map[string]any    `json:"workflowInput,omitempty"`
	ViewportProfile   ViewportProfile   `json:"viewportProfile,omitempty"`
}

type RecordingSegment struct {
	SegmentID    string `json:"segmentId"`
	ThreadID     string `json:"threadId"`
	Timestamp    int64  `json:"timestamp"`
	Summary      string `json:"summary"`
	ImageDataURL string `json:"imageDataUrl,omitempty"`
}

type FailureReport struct {
	ThreadID       string                 `json:"threadId"`
	RuntimeBackend RuntimeBackend         `json:"runtimeBackend"`
	ErrorClass     string                 `json:"errorClass"`
	ErrorMessage   string                 `json:"errorMessage"`
	StepTrace      []string               `json:"stepTrace,omitempty"`
	Artifacts      map[string]interface{} `json:"artifacts,omitempty"`
}

type Event struct {
	EventName      string            `json:"eventName"`
	ThreadID       string            `json:"threadId"`
	Content        string            `json:"content,omitempty"`
	Thinking       string            `json:"thinking,omitempty"`
	ToolName       string            `json:"toolName,omitempty"`
	ToolResult     *bool             `json:"toolResult,omitempty"`
	ToolResultData interface{}       `json:"toolResultData,omitempty"`
	ToolState      interface{}       `json:"toolState,omitempty"`
	Error          string            `json:"error,omitempty"`
	Report         *FailureReport    `json:"report,omitempty"`
	Segment        *RecordingSegment `json:"segment,omitempty"`
	Controlled     *bool             `json:"controlled,omitempty"`
	Runtime        RuntimeBackend    `json:"runtime,omitempty"`
	RunID          string            `json:"runId,omitempty"`
	ItemID         string            `json:"itemId,omitempty"`
	Stage          string            `json:"stage,omitempty"`
	Status         string            `json:"status,omitempty"`
	Attempt        int               `json:"attempt,omitempty"`
	DurationMS     int64             `json:"durationMs,omitempty"`
	Evidence       string            `json:"evidence,omitempty"`
	MissingFields  []string          `json:"missingFields,omitempty"`
	StartedAt      string            `json:"startedAt,omitempty"`
	EndedAt        string            `json:"endedAt,omitempty"`
	Failed         int               `json:"failed,omitempty"`
	Canceled       int               `json:"canceled,omitempty"`
	Completed      int               `json:"completed,omitempty"`
	Total          int               `json:"total,omitempty"`
	Summary        string            `json:"summary,omitempty"`
}

type RunResponse struct {
	Success bool        `json:"success"`
	Summary string      `json:"summary"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
}

type ModelsResponse struct {
	Models []string `json:"models"`
}
