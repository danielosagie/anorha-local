//go:build windows || darwin

package credentials

import (
	"fmt"
	"os"
	"strings"
)

type Provider string

const (
	ProviderOpenRouter  Provider = "openrouter"
	ProviderKimi        Provider = "kimi"
	ProviderOllamaCloud Provider = "ollama_cloud"
)

type Store struct {
	ServiceName string
}

func NewStore(service string) *Store {
	if service == "" {
		service = "anorha-local"
	}
	return &Store{ServiceName: service}
}

func (s *Store) Set(provider Provider, secret string) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return fmt.Errorf("secret is required")
	}
	return setSecret(s.ServiceName, string(provider), secret)
}

func (s *Store) Get(provider Provider) (string, string, error) {
	if v := strings.TrimSpace(envForProvider(provider)); v != "" {
		return v, "env", nil
	}
	secret, err := getSecret(s.ServiceName, string(provider))
	if err != nil {
		return "", "", err
	}
	if strings.TrimSpace(secret) == "" {
		return "", "", nil
	}
	return secret, "keychain", nil
}

func (s *Store) Status(provider Provider) (bool, string) {
	secret, source, _ := s.Get(provider)
	return strings.TrimSpace(secret) != "", source
}

func EnvVarName(provider Provider) string {
	switch provider {
	case ProviderOpenRouter:
		return "OPENROUTER_API_KEY"
	case ProviderKimi:
		return "MOONSHOT_API_KEY"
	case ProviderOllamaCloud:
		return "OLLAMA_CLOUD_API_KEY"
	default:
		return ""
	}
}

func envForProvider(provider Provider) string {
	key := EnvVarName(provider)
	if key == "" {
		return ""
	}
	return os.Getenv(key)
}
