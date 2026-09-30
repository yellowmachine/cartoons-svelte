// Package httpapi exposes the bridge's closed set of HTTP endpoints.
package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/yellowmachine/cartoons-svelte/jellyfin-bridge/internal/auth"
	"github.com/yellowmachine/cartoons-svelte/jellyfin-bridge/internal/jellyfin"
)

// Jellyfin is what the handlers need from the Jellyfin client (mocked in tests).
type Jellyfin interface {
	Ping(ctx context.Context) error
	Folders(ctx context.Context) ([]jellyfin.Folder, error)
	FolderItems(ctx context.Context, folderID string, unplayedOnly bool) ([]jellyfin.Item, error)
	ReplacePlaylist(ctx context.Context, itemIDs []string) (string, error)
	Sessions(ctx context.Context) ([]jellyfin.Session, error)
	Play(ctx context.Context, sessionID string, itemIDs []string) error
	Image(ctx context.Context, itemID string) (*jellyfin.Image, error)
}

type Server struct {
	jf  Jellyfin
	log *slog.Logger
}

func New(jf Jellyfin, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	return &Server{jf: jf, log: log}
}

// Handler returns the full handler chain: request logging, then auth, then routes.
func (s *Server) Handler(token string) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /folders", s.folders)
	mux.HandleFunc("GET /folders/{id}/items", s.folderItems)
	mux.HandleFunc("PUT /playlist", s.replacePlaylist)
	mux.HandleFunc("GET /sessions", s.sessions)
	mux.HandleFunc("POST /sessions/{id}/play", s.play)
	mux.HandleFunc("GET /items/{id}/image", s.image)

	public := func(r *http.Request) bool { return r.Method == http.MethodGet && r.URL.Path == "/healthz" }
	return s.logRequests(auth.Middleware(token, public, mux))
}

// logRequests logs one line per request. It never logs headers, so the
// Authorization token can't end up in the logs.
func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		level := slog.LevelInfo
		if r.URL.Path == "/healthz" {
			level = slog.LevelDebug
		}
		s.log.Log(r.Context(), level, "request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration_ms", time.Since(start).Milliseconds(),
		)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (r *statusRecorder) WriteHeader(code int) {
	if !r.wroteHeader {
		r.status, r.wroteHeader = code, true
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }
