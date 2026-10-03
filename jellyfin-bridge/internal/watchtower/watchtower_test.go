package watchtower

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTriggerUpdate(t *testing.T) {
	status := http.StatusAccepted
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/update" || r.URL.RawQuery != "async=true" {
			t.Errorf("got %s %s", r.Method, r.URL)
		}
		if r.Header.Get("Authorization") != "Bearer wt-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(status)
	}))
	defer srv.Close()

	c := New(srv.URL+"/", "wt-token")
	if err := c.TriggerUpdate(context.Background()); err != nil {
		t.Errorf("202: %v", err)
	}
	status = http.StatusTooManyRequests
	if err := c.TriggerUpdate(context.Background()); !errors.Is(err, ErrBusy) {
		t.Errorf("429: got %v", err)
	}
	if err := New(srv.URL, "wrong").TriggerUpdate(context.Background()); err == nil {
		t.Error("401 accepted")
	}
	if err := New("http://127.0.0.1:1", "x").TriggerUpdate(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Errorf("down: got %v", err)
	}
}
