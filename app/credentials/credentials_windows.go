//go:build windows

package credentials

import (
	"fmt"
	"os/exec"
	"strings"
)

func setSecret(service string, account string, secret string) error {
	target := service + ":" + account
	cmd := exec.Command("powershell", "-NoProfile", "-Command", "$vault = New-Object Windows.Security.Credentials.PasswordVault; $cred = New-Object Windows.Security.Credentials.PasswordCredential('"+target+"','"+account+"','"+secret+"'); $vault.Add($cred)")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("set secret failed: %s (%w)", strings.TrimSpace(string(out)), err)
	}
	return nil
}

func getSecret(service string, account string) (string, error) {
	target := service + ":" + account
	cmd := exec.Command("powershell", "-NoProfile", "-Command", "$vault = New-Object Windows.Security.Credentials.PasswordVault; try { $cred = $vault.Retrieve('"+target+"','"+account+"'); $cred.RetrievePassword(); Write-Output $cred.Password } catch { Write-Output '' }")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("get secret failed: %s (%w)", strings.TrimSpace(string(out)), err)
	}
	return strings.TrimSpace(string(out)), nil
}
