// Package config loads the bridge configuration from environment variables.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"strings"

	"github.com/yellowmachine/cartoons-svelte/jellyfin-bridge/internal/jellyfin"
)

const MinTokenLength = 32

type Config struct {
	JellyfinURL    string // without a trailing slash
	JellyfinAPIKey string
	JellyfinUserID string
	PlaylistName   string
	ListenAddr     string
	Token          string
	LogLevel       slog.Level
}

// Load reads the configuration. getenv and readFile are injected for tests.
func Load(getenv func(string) string, readFile func(string) ([]byte, error)) (Config, error) {
	get := func(key, def string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return def
	}

	var cfg Config
	var errs []error

	// secret reads KEY or KEY_FILE (Docker secrets), but not both.
	secret := func(key string) string {
		value, file := getenv(key), getenv(key+"_FILE")
		switch {
		case value != "" && file != "":
			errs = append(errs, fmt.Errorf("set only one of %s and %s_FILE", key, key))
		case file != "":
			b, err := readFile(file)
			if err != nil {
				errs = append(errs, fmt.Errorf("%s_FILE: %w", key, err))
			}
			value = string(b)
		}
		return strings.TrimSpace(value)
	}

	cfg.JellyfinURL = strings.TrimRight(get("JELLYFIN_URL", ""), "/")
	if cfg.JellyfinURL == "" {
		errs = append(errs, errors.New("JELLYFIN_URL is required"))
	} else if u, err := url.Parse(cfg.JellyfinURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		errs = append(errs, errors.New("JELLYFIN_URL must be an http:// or https:// URL"))
	}

	cfg.JellyfinUserID = get("JELLYFIN_USER_ID", "")
	if cfg.JellyfinUserID == "" {
		errs = append(errs, errors.New("JELLYFIN_USER_ID is required"))
	} else if !jellyfin.ValidID(cfg.JellyfinUserID) {
		errs = append(errs, errors.New("JELLYFIN_USER_ID must be a Jellyfin id (32 hex characters)"))
	}

	if cfg.JellyfinAPIKey = secret("JELLYFIN_API_KEY"); cfg.JellyfinAPIKey == "" {
		errs = append(errs, errors.New("JELLYFIN_API_KEY (or JELLYFIN_API_KEY_FILE) is required"))
	}

	cfg.PlaylistName = get("PLAYLIST_NAME", "Para ver hoy")

	cfg.ListenAddr = get("LISTEN_ADDR", "127.0.0.1:8787")
	if _, _, err := net.SplitHostPort(cfg.ListenAddr); err != nil {
		errs = append(errs, fmt.Errorf("LISTEN_ADDR: %w", err))
	}

	cfg.Token = secret("API_TOKEN")
	switch {
	case cfg.Token == "":
		errs = append(errs, errors.New("API_TOKEN (or API_TOKEN_FILE) is required"))
	case len(cfg.Token) < MinTokenLength:
		errs = append(errs, fmt.Errorf("API_TOKEN must be at least %d characters (try: openssl rand -hex 32)", MinTokenLength))
	}

	if err := cfg.LogLevel.UnmarshalText([]byte(get("LOG_LEVEL", "info"))); err != nil {
		errs = append(errs, fmt.Errorf("LOG_LEVEL: %w", err))
	}

	return cfg, errors.Join(errs...)
}
