package jellyfin

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

const (
	userID  = "00000000000000000000000000000001"
	apiKey  = "secret-key"
	session = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)

// fakeJellyfin serves canned answers and records "METHOD path?query" calls.
type fakeJellyfin struct {
	mu     sync.Mutex
	calls  []string
	routes map[string]func(w http.ResponseWriter, r *http.Request)
}

func newFake(t *testing.T) (*fakeJellyfin, *Client) {
	f := &fakeJellyfin{routes: map[string]func(http.ResponseWriter, *http.Request){}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != `MediaBrowser Token="`+apiKey+`"` {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		f.mu.Lock()
		f.calls = append(f.calls, r.Method+" "+r.URL.Path+"?"+r.URL.RawQuery)
		f.mu.Unlock()
		if h, ok := f.routes[r.Method+" "+r.URL.Path]; ok {
			h(w, r)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	return f, New(Config{URL: srv.URL, APIKey: apiKey, UserID: userID, PlaylistName: "Para ver hoy"})
}

func (f *fakeJellyfin) on(route string, v any) {
	f.routes[route] = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
}

func (f *fakeJellyfin) called(prefix string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			out = append(out, c)
		}
	}
	return out
}

func TestValidID(t *testing.T) {
	for id, want := range map[string]bool{
		"0123456789abcdefABCDEF0123456789":     true,
		"01234567-89ab-cdef-0123-456789abcdef": true,
		"0123456789abcdef":                     false,
		"0123456789abcdef0123456789abcdeg":     false,
		"../Users/0123456789abcdef0123456789":  false,
	} {
		if ValidID(id) != want {
			t.Errorf("ValidID(%q) = %v", id, !want)
		}
	}
}

func TestFolderItemsMapsFields(t *testing.T) {
	f, c := newFake(t)
	f.on("GET /Users/"+userID+"/Items", map[string]any{"Items": []map[string]any{
		{"Id": "a", "Name": "Ep 1", "SeriesName": "S", "ParentIndexNumber": 1, "IndexNumber": 2, "ImageTags": map[string]string{"Primary": "t"}},
		{"Id": "b", "Name": "Movie"},
	}})
	items, err := c.FolderItems(context.Background(), "f", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || !items[0].HasImage || *items[0].Season != 1 || *items[0].Episode != 2 || items[1].HasImage || items[1].Season != nil {
		t.Errorf("got %+v", items)
	}
	if calls := f.called("GET /Users/"); len(calls) != 1 || !strings.Contains(calls[0], "Filters=IsUnplayed") || !strings.Contains(calls[0], "ParentId=f") {
		t.Errorf("calls %v", calls)
	}
}

func TestReplacePlaylistDeletesOnlyExactMatches(t *testing.T) {
	f, c := newFake(t)
	keep := "11111111111111111111111111111111"
	drop := "22222222222222222222222222222222"
	f.on("GET /Users/"+userID+"/Items", map[string]any{"Items": []map[string]any{
		{"Id": keep, "Name": "Para ver hoy (viejo)"},
		{"Id": drop, "Name": "Para ver hoy"},
	}})
	f.routes["DELETE /Items/"+drop] = func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }
	var created map[string]any
	f.routes["POST /Playlists"] = func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&created)
		_, _ = io.WriteString(w, `{"Id":"new"}`)
	}

	id, err := c.ReplacePlaylist(context.Background(), []string{"x", "y"})
	if err != nil || id != "new" {
		t.Fatalf("got %q, %v", id, err)
	}
	if deletes := f.called("DELETE"); len(deletes) != 1 || !strings.Contains(deletes[0], drop) {
		t.Errorf("deletes %v", deletes)
	}
	if created["Name"] != "Para ver hoy" || created["UserId"] != userID || len(created["Ids"].([]any)) != 2 {
		t.Errorf("created %v", created)
	}
}

func TestPlayOnlyOnControllableSessions(t *testing.T) {
	f, c := newFake(t)
	f.on("GET /Sessions", []map[string]any{
		{"Id": session, "DeviceName": "Salón", "Client": "Android TV", "SupportsRemoteControl": true},
		{"Id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "DeviceName": "Web", "SupportsRemoteControl": false},
	})
	f.routes["POST /Sessions/"+session+"/Playing"] = func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }

	sessions, err := c.Sessions(context.Background())
	if err != nil || len(sessions) != 1 || sessions[0].DeviceName != "Salón" {
		t.Fatalf("got %+v, %v", sessions, err)
	}
	if calls := f.called("GET /Sessions"); !strings.Contains(calls[0], "ControllableByUserId="+userID) {
		t.Errorf("calls %v", calls)
	}

	if err := c.Play(context.Background(), session, []string{"x", "y"}); err != nil {
		t.Fatal(err)
	}
	if plays := f.called("POST /Sessions/"); len(plays) != 1 || !strings.Contains(plays[0], "ItemIds=x%2Cy") {
		t.Errorf("plays %v", plays)
	}
	if err := c.Play(context.Background(), "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", []string{"x"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("non-controllable session: got %v", err)
	}
}

func TestErrorMapping(t *testing.T) {
	f, c := newFake(t)
	f.routes["GET /Users/"+userID+"/Views"] = func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, "boom")
	}
	var se *StatusError
	if _, err := c.Folders(context.Background()); !errors.As(err, &se) || se.Status != 500 {
		t.Errorf("500: got %v", err)
	}
	if _, err := c.Image(context.Background(), "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("404: got %v", err)
	}

	c.cfg.APIKey = "wrong"
	if err := c.Ping(context.Background()); !errors.Is(err, ErrRejected) {
		t.Errorf("401: got %v", err)
	}

	down := New(Config{URL: "http://127.0.0.1:1", APIKey: apiKey, UserID: userID})
	if err := down.Ping(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Errorf("down: got %v", err)
	}
}

func TestImageRejectsNonImages(t *testing.T) {
	f, c := newFake(t)
	f.routes["GET /Items/i/Images/Primary"] = func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("maxHeight") != "400" {
			t.Errorf("query %v", r.URL.Query())
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, "<html>")
	}
	if _, err := c.Image(context.Background(), "i"); err == nil {
		t.Error("text/html accepted as an image")
	}
}
