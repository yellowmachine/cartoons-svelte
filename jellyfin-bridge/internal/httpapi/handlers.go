package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/yellowmachine/cartoons-svelte/jellyfin-bridge/internal/jellyfin"
	"github.com/yellowmachine/cartoons-svelte/jellyfin-bridge/internal/watchtower"
)

const (
	maxBodyBytes     = 64 << 10
	maxItemIDs       = 200
	healthzTimeout   = 3 * time.Second
	jellyfinDeadline = 30 * time.Second
)

// --- helpers ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func errorJSON(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// fail maps an error to a response. Anything that isn't the caller's fault
// gets a generic message and is logged here instead.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, jellyfin.ErrNotFound):
		errorJSON(w, http.StatusNotFound, "not found")
	case errors.Is(err, jellyfin.ErrUnavailable):
		s.log.Warn("jellyfin unavailable", "path", r.URL.Path, "err", err)
		errorJSON(w, http.StatusServiceUnavailable, "jellyfin unavailable")
	case errors.Is(err, jellyfin.ErrRejected):
		s.log.Error("jellyfin rejected the API key; check JELLYFIN_API_KEY", "path", r.URL.Path)
		errorJSON(w, http.StatusBadGateway, "jellyfin error")
	case errors.Is(err, context.DeadlineExceeded):
		errorJSON(w, http.StatusGatewayTimeout, "timeout")
	case errors.Is(err, context.Canceled):
		// The client went away; nobody reads this.
		w.WriteHeader(499)
	default:
		s.log.Error("request failed", "path", r.URL.Path, "err", err)
		errorJSON(w, http.StatusBadGateway, "jellyfin error")
	}
}

// decode reads a single JSON object, rejecting unknown fields, trailing data
// and bodies over maxBodyBytes. It writes the error response itself.
func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	dec.DisallowUnknownFields()
	err := dec.Decode(dst)
	if err == nil && dec.Decode(&struct{}{}) != io.EOF {
		err = errors.New("body must contain a single JSON object")
	}
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			errorJSON(w, http.StatusRequestEntityTooLarge, "body too large")
		} else {
			errorJSON(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		}
		return false
	}
	return true
}

// pathID reads a Jellyfin id from the URL path, answering 400 if it isn't one.
func pathID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("id")
	if !jellyfin.ValidID(id) {
		errorJSON(w, http.StatusBadRequest, "invalid id")
		return "", false
	}
	return id, true
}

type itemIDsBody struct {
	ItemIDs []string `json:"item_ids"`
}

// decodeItemIDs reads {"item_ids": [...]}: 1 to maxItemIDs valid ids.
func decodeItemIDs(w http.ResponseWriter, r *http.Request) ([]string, bool) {
	var body itemIDsBody
	if !decode(w, r, &body) {
		return nil, false
	}
	if len(body.ItemIDs) == 0 || len(body.ItemIDs) > maxItemIDs {
		errorJSON(w, http.StatusBadRequest, "item_ids must have 1 to "+strconv.Itoa(maxItemIDs)+" ids")
		return nil, false
	}
	for _, id := range body.ItemIDs {
		if !jellyfin.ValidID(id) {
			errorJSON(w, http.StatusBadRequest, "invalid id in item_ids")
			return nil, false
		}
	}
	return body.ItemIDs, true
}

func withDeadline(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), jellyfinDeadline)
}

// --- handlers ---

// healthz is public and always 200 while the bridge runs; whether Jellyfin
// answers is reported in the body.
func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), healthzTimeout)
	defer cancel()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "jellyfin": s.jf.Ping(ctx) == nil})
}

func (s *Server) folders(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := withDeadline(r)
	defer cancel()
	folders, err := s.jf.Folders(ctx)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, folders)
}

func (s *Server) folderItems(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	unplayed := false
	if v := r.URL.Query().Get("unplayed"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			errorJSON(w, http.StatusBadRequest, "unplayed must be true or false")
			return
		}
		unplayed = b
	}
	ctx, cancel := withDeadline(r)
	defer cancel()
	items, err := s.jf.FolderItems(ctx, id, unplayed)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) replacePlaylist(w http.ResponseWriter, r *http.Request) {
	ids, ok := decodeItemIDs(w, r)
	if !ok {
		return
	}
	ctx, cancel := withDeadline(r)
	defer cancel()
	id, err := s.jf.ReplacePlaylist(ctx, ids)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

func (s *Server) sessions(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := withDeadline(r)
	defer cancel()
	sessions, err := s.jf.Sessions(ctx)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, sessions)
}

func (s *Server) play(w http.ResponseWriter, r *http.Request) {
	sessionID, ok := pathID(w, r)
	if !ok {
		return
	}
	ids, ok := decodeItemIDs(w, r)
	if !ok {
		return
	}
	ctx, cancel := withDeadline(r)
	defer cancel()
	if err := s.jf.Play(ctx, sessionID, ids); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) image(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	ctx, cancel := withDeadline(r)
	defer cancel()
	img, err := s.jf.Image(ctx, id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	defer img.Body.Close()
	w.Header().Set("Content-Type", img.ContentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if img.Length >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(img.Length, 10))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, img.Body)
}

// update asks Watchtower to pull a new image of the bridge (and anything else
// it watches). It takes no input: the caller can only say "check now".
func (s *Server) update(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	err := s.updater.TriggerUpdate(ctx)
	switch {
	case err == nil:
		s.log.Info("update triggered")
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "update started"})
	case errors.Is(err, watchtower.ErrBusy):
		errorJSON(w, http.StatusConflict, "an update is already running")
	case errors.Is(err, watchtower.ErrUnavailable):
		s.log.Error("watchtower unavailable", "err", err)
		errorJSON(w, http.StatusServiceUnavailable, "watchtower unavailable")
	default:
		s.log.Error("update failed", "err", err)
		errorJSON(w, http.StatusBadGateway, "watchtower error")
	}
}
