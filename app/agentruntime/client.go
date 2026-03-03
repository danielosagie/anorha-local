//go:build windows || darwin

package agentruntime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	BaseURL string
	HTTP    *http.Client
}

func NewClient(baseURL string) *Client {
	timeout := 5 * time.Minute
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP: &http.Client{
			Timeout: timeout,
		},
	}
}

func (c *Client) Health(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/health", nil)
	if err != nil {
		return err
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("runtime health status %d", res.StatusCode)
	}
	return nil
}

func (c *Client) SetOptions(ctx context.Context, threadID string, options RuntimeOptions) error {
	payload := map[string]interface{}{
		"threadId": threadID,
		"options":  options,
	}
	_, err := c.postJSON(ctx, "/v1/options", payload)
	return err
}

func (c *Client) Run(ctx context.Context, payload RunPayload) (*RunResponse, error) {
	body, err := c.postJSON(ctx, "/v1/run", payload)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	var out RunResponse
	if err := json.NewDecoder(body).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Intervene(ctx context.Context, threadID string) error {
	_, err := c.postJSON(ctx, "/v1/intervene", map[string]interface{}{"threadId": threadID})
	return err
}

func (c *Client) Resume(ctx context.Context, threadID string) error {
	_, err := c.postJSON(ctx, "/v1/resume", map[string]interface{}{"threadId": threadID})
	return err
}

func (c *Client) GetRecording(ctx context.Context, threadID string, segmentID string) (*RecordingSegment, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/v1/recordings/%s/%s", c.BaseURL, threadID, segmentID), nil)
	if err != nil {
		return nil, err
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("runtime recording status %d", res.StatusCode)
	}
	var payload struct {
		Segment RecordingSegment `json:"segment"`
	}
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return nil, err
	}
	return &payload.Segment, nil
}

func (c *Client) ListModels(ctx context.Context, route ProviderRoute) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/v1/providers/models?route="+string(route), nil)
	if err != nil {
		return nil, err
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("runtime models status %d", res.StatusCode)
	}
	var out ModelsResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.Models, nil
}

func (c *Client) StreamEvents(ctx context.Context, threadID string, onEvent func(Event) error) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/v1/events/"+threadID, nil)
	if err != nil {
		return err
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("runtime events status %d", res.StatusCode)
	}

	scanner := bufio.NewScanner(res.Body)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 2*1024*1024)

	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data: "))
		if payload == "" {
			continue
		}
		var event Event
		if err := json.Unmarshal([]byte(payload), &event); err != nil {
			continue
		}
		if err := onEvent(event); err != nil {
			return err
		}
	}

	if err := scanner.Err(); err != nil && err != io.EOF {
		return err
	}
	return nil
}

func (c *Client) postJSON(ctx context.Context, path string, payload interface{}) (io.ReadCloser, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 400 {
		defer res.Body.Close()
		errBody, _ := io.ReadAll(res.Body)
		return nil, fmt.Errorf("runtime post %s status %d: %s", path, res.StatusCode, strings.TrimSpace(string(errBody)))
	}
	return res.Body, nil
}
