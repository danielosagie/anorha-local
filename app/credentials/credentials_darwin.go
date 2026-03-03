//go:build darwin

package credentials

import (
	"bytes"
	"fmt"
	"os/exec"
	"strings"
)

func setSecret(service string, account string, secret string) error {
	// delete existing entry first so updates are idempotent
	_ = exec.Command("security", "delete-generic-password", "-s", service, "-a", account).Run()
	cmd := exec.Command("security", "add-generic-password", "-U", "-s", service, "-a", account, "-w", secret)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("set secret failed: %s (%w)", strings.TrimSpace(string(out)), err)
	}
	return nil
}

func getSecret(service string, account string) (string, error) {
	cmd := exec.Command("security", "find-generic-password", "-s", service, "-a", account, "-w")
	out, err := cmd.CombinedOutput()
	if err != nil {
		if bytes.Contains(out, []byte("could not be found")) {
			return "", nil
		}
		return "", fmt.Errorf("get secret failed: %s (%w)", strings.TrimSpace(string(out)), err)
	}
	return strings.TrimSpace(string(out)), nil
}
