package httpapi

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

	"github.com/yellowmachine/cartoons-svelte/jellyfin-bridge/internal/jellyfin"
)

const (
	token   = "test-token-0123456789abcdef0123456789"
	itemA   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	itemB   = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	session = "cccccccccccccccccccccccccccccccc"
)

// fakeJellyfin records calls; err (if set) is returned by every operation.
type fakeJellyfin struct {
	mu    sync.Mutex
	calls []string
	err   error
}

func (f *fakeJellyfin) record(format string, args ...any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	call := format
	for _, a := range args {
		b, _ := json.Marshal(a)
		call += " " + string(b)
	}
	f.calls = append(f.calls, call)
	return f.err
}

func (f *fakeJellyfin) last() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.calls) == 0 {
		return ""
	}
	return f.calls[len(f.calls)-1]
}

func (f *fakeJellyfin) Ping(ctx context.Context) error { return f.record("ping") }
func (f *fakeJellyfin) Folders(ctx context.Context) ([]jellyfin.Folder, error) {
	return []jellyfin.Folder{{ID: itemA, Name: "Pingu"}}, f.record("folders")
}
func (f *fakeJellyfin) FolderItems(ctx context.Context, id string, unplayed bool) ([]jellyfin.Item, error) {
	return []jellyfin.Item{{ID: itemB, Name: "Ep", HasImage: true}}, f.record("items", id, unplayed)
}
func (f *fakeJellyfin) ReplacePlaylist(ctx context.Context, ids []string) (string, error) {
	return "new", f.record("playlist", ids)
}
func (f *fakeJellyfin) Sessions(ctx context.Context) ([]jellyfin.Session, error) {
	return []jellyfin.Session{{ID: session, DeviceName: "Salón"}}, f.record("sessions")
}
func (f *fakeJellyfin) Play(ctx context.Context, id string, ids []string) error {
	return f.record("play", id, ids)
}
func (f *fakeJellyfin) Image(ctx context.Context, id string) (*jellyfin.Image, error) {
	if err := f.record("image", id); err != nil {
		return nil, err
	}
	return &jellyfin.Image{ContentType: "image/jpeg", Length: 3, Body: io.NopCloser(strings.NewReader("jpg"))}, nil
}

func newHandler() (*fakeJellyfin, http.Handler) {
	f := &fakeJellyfin{}
	return f, New(f, nil).Handler(token)
}

func do(h http.Handler, method, path, body string, authed bool) *httptest.ResponseRecorder {
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rd)
	if authed {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestAuth(t *testing.T) {
	_, h := newHandler()
	if rec := do(h, "GET", "/folders", "", false); rec.Code != http.StatusUnauthorized {
		t.Errorf("no token: %d", rec.Code)
	}
	if rec := do(h, "GET", "/healthz", "", false); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"jellyfin":true`) {
		t.Errorf("healthz: %d %s", rec.Code, rec.Body)
	}
	if rec := do(h, "GET", "/folders", "", true); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Pingu") {
		t.Errorf("folders: %d %s", rec.Code, rec.Body)
	}
}

func TestFolderItems(t *testing.T) {
	f, h := newHandler()
	rec := do(h, "GET", "/folders/"+itemA+"/items?unplayed=true", "", true)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"has_image":true`) {
		t.Errorf("got %d %s", rec.Code, rec.Body)
	}
	if want := `items "` + itemA + `" true`; f.last() != want {
		t.Errorf("call %q, want %q", f.last(), want)
	}
	if rec := do(h, "GET", "/folders/"+itemA+"/items?unplayed=maybe", "", true); rec.Code != http.StatusBadRequest {
		t.Errorf("bad unplayed: %d", rec.Code)
	}
	if rec := do(h, "GET", "/folders/nope/items", "", true); rec.Code != http.StatusBadRequest {
		t.Errorf("bad id: %d", rec.Code)
	}
}

func TestReplacePlaylistValidatesIDs(t *testing.T) {
	f, h := newHandler()
	rec := do(h, "PUT", "/playlist", `{"item_ids":["`+itemA+`","`+itemB+`"]}`, true)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"id":"new"`) {
		t.Errorf("got %d %s", rec.Code, rec.Body)
	}
	if !strings.HasPrefix(f.last(), "playlist") {
		t.Errorf("call %q", f.last())
	}

	many := strings.TrimSuffix(strings.Repeat(`"`+itemA+`",`, maxItemIDs+1), ",")
	for name, body := range map[string]string{
		"empty":       `{"item_ids":[]}`,
		"bad id":      `{"item_ids":["../Users"]}`,
		"unknown key": `{"item_ids":["` + itemA + `"],"name":"x"}`,
		"too many":    `{"item_ids":[` + many + `]}`,
		"not json":    `nope`,
	} {
		if rec := do(h, "PUT", "/playlist", body, true); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: %d", name, rec.Code)
		}
	}
}

func TestPlay(t *testing.T) {
	f, h := newHandler()
	if rec := do(h, "POST", "/sessions/"+session+"/play", `{"item_ids":["`+itemA+`"]}`, true); rec.Code != http.StatusNoContent {
		t.Errorf("got %d %s", rec.Code, rec.Body)
	}
	if want := `play "` + session + `" ["` + itemA + `"]`; f.last() != want {
		t.Errorf("call %q, want %q", f.last(), want)
	}
	f.err = jellyfin.ErrNotFound
	if rec := do(h, "POST", "/sessions/"+session+"/play", `{"item_ids":["`+itemA+`"]}`, true); rec.Code != http.StatusNotFound {
		t.Errorf("unknown session: %d", rec.Code)
	}
}

func TestImage(t *testing.T) {
	_, h := newHandler()
	rec := do(h, "GET", "/items/"+itemA+"/image", "", true)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/jpeg" || rec.Body.String() != "jpg" {
		t.Errorf("got %d %v %q", rec.Code, rec.Header(), rec.Body)
	}
}

func TestErrorMapping(t *testing.T) {
	for err, want := range map[error]int{
		jellyfin.ErrUnavailable:                            http.StatusServiceUnavailable,
		jellyfin.ErrRejected:                               http.StatusBadGateway,
		&jellyfin.StatusError{Status: 500}:                 http.StatusBadGateway,
		context.DeadlineExceeded:                           http.StatusGatewayTimeout,
		errors.Join(errors.New("x"), jellyfin.ErrNotFound): http.StatusNotFound,
	} {
		f, h := newHandler()
		f.err = err
		if rec := do(h, "GET", "/sessions", "", true); rec.Code != want {
			t.Errorf("%v: got %d, want %d", err, rec.Code, want)
		}
	}
	f, h := newHandler()
	f.err = jellyfin.ErrUnavailable
	if rec := do(h, "GET", "/healthz", "", false); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"jellyfin":false`) {
		t.Errorf("healthz while down: %d %s", rec.Code, rec.Body)
	}
}
