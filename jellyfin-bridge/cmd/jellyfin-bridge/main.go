// Command jellyfin-bridge exposes a closed set of Jellyfin actions over an
// authenticated HTTP API, so the Jellyfin API key never leaves home. Run
// "jellyfin-bridge healthcheck" to probe a running instance (used by the
// container HEALTHCHECK, since the image has no curl).
package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/yellowmachine/cartoons-svelte/jellyfin-bridge/internal/config"
	"github.com/yellowmachine/cartoons-svelte/jellyfin-bridge/internal/httpapi"
	"github.com/yellowmachine/cartoons-svelte/jellyfin-bridge/internal/jellyfin"
	"github.com/yellowmachine/cartoons-svelte/jellyfin-bridge/internal/watchtower"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	os.Exit(run())
}

func run() int {
	cfg, err := config.Load(os.Getenv, os.ReadFile)
	if err != nil {
		slog.Error("invalid configuration", "err", err)
		return 1
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	jf := jellyfin.New(jellyfin.Config{
		URL:          cfg.JellyfinURL,
		APIKey:       cfg.JellyfinAPIKey,
		UserID:       cfg.JellyfinUserID,
		PlaylistName: cfg.PlaylistName,
	})

	var updater httpapi.Updater
	if cfg.UpdateToken != "" {
		updater = watchtower.New(cfg.WatchtowerURL, cfg.WatchtowerToken)
	}

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           httpapi.New(jf, updater, log).Handler(cfg.Token, cfg.UpdateToken),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      45 * time.Second, // > the 30 s budget for a Jellyfin call
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.ListenAndServe() }()
	log.Info("listening", "addr", cfg.ListenAddr, "jellyfin", cfg.JellyfinURL, "update_webhook", updater != nil)

	code := 0
	select {
	case <-ctx.Done():
		log.Info("shutting down")
	case err := <-serveErr:
		log.Error("server failed", "err", err)
		code = 1
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("shutdown", "err", err)
		code = 1
	}
	return code
}

// healthcheck probes /healthz on LISTEN_ADDR and exits 0 on 200. The bridge
// is healthy even while Jellyfin is down; that is reported in the body instead.
func healthcheck() int {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8787"
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return 1
	}
	if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
		host = "127.0.0.1"
	}
	c := http.Client{Timeout: 5 * time.Second}
	resp, err := c.Get("http://" + net.JoinHostPort(host, port) + "/healthz")
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
