package config

import (
	"errors"
	"strings"
	"testing"
)

const (
	token  = "0123456789abcdef0123456789abcdef"
	userID = "0123456789abcdef0123456789abcdef"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func noFile(string) ([]byte, error) { return nil, errors.New("no file") }

func valid() map[string]string {
	return map[string]string{
		"API_TOKEN":        token,
		"JELLYFIN_URL":     "http://jellyfin:8096/",
		"JELLYFIN_USER_ID": userID,
		"JELLYFIN_API_KEY": "key",
	}
}

func TestDefaults(t *testing.T) {
	cfg, err := Load(env(valid()), noFile)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.JellyfinURL != "http://jellyfin:8096" || cfg.ListenAddr != "127.0.0.1:8787" || cfg.PlaylistName != "Para ver hoy" {
		t.Errorf("got %+v", cfg)
	}
}

func TestTokenRequiredAndLongEnough(t *testing.T) {
	m := valid()
	delete(m, "API_TOKEN")
	if _, err := Load(env(m), noFile); err == nil || !strings.Contains(err.Error(), "API_TOKEN (or") {
		t.Errorf("missing token: got %v", err)
	}
	m["API_TOKEN"] = "short"
	if _, err := Load(env(m), noFile); err == nil {
		t.Error("short token accepted")
	}
	m["API_TOKEN"], m["API_TOKEN_FILE"] = token, "/run/secrets/t"
	if _, err := Load(env(m), noFile); err == nil {
		t.Error("both token sources accepted")
	}
}

func TestSecretFilesAreTrimmed(t *testing.T) {
	m := valid()
	delete(m, "API_TOKEN")
	delete(m, "JELLYFIN_API_KEY")
	m["API_TOKEN_FILE"], m["JELLYFIN_API_KEY_FILE"] = "/run/secrets/t", "/run/secrets/k"
	read := func(p string) ([]byte, error) {
		if p == "/run/secrets/k" {
			return []byte("key\n"), nil
		}
		return []byte(token + "\n"), nil
	}
	cfg, err := Load(env(m), read)
	if err != nil || cfg.Token != token || cfg.JellyfinAPIKey != "key" {
		t.Errorf("got %+v, %v", cfg, err)
	}
}

func TestJellyfinSettingsAreValidated(t *testing.T) {
	for key, bad := range map[string]string{
		"JELLYFIN_URL":     "ftp://jellyfin",
		"JELLYFIN_USER_ID": "not-an-id",
		"JELLYFIN_API_KEY": "",
	} {
		m := valid()
		m[key] = bad
		if _, err := Load(env(m), noFile); err == nil || !strings.Contains(err.Error(), key) {
			t.Errorf("%s=%q: got %v", key, bad, err)
		}
	}
}
