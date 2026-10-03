// Package watchtower asks a Watchtower instance on the internal network to
// pull new images and restart the containers it watches (this bridge among
// them). It never reaches the Docker socket itself.
package watchtower

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

var (
	// ErrBusy means Watchtower is already running an update.
	ErrBusy = errors.New("watchtower is already updating")
	// ErrUnavailable means Watchtower could not be reached.
	ErrUnavailable = errors.New("watchtower unavailable")
)

type Client struct {
	url   string // without a trailing slash
	token string
	http  *http.Client
}

func New(url, token string) *Client {
	return &Client{url: strings.TrimRight(url, "/"), token: token, http: &http.Client{Timeout: 10 * time.Second}}
}

// TriggerUpdate starts an update in the background (?async=true) and returns
// as soon as Watchtower accepts it, so restarting this bridge doesn't cut
// the request short.
func (c *Client) TriggerUpdate(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url+"/v1/update?async=true", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))

	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil
	case resp.StatusCode == http.StatusTooManyRequests:
		return ErrBusy
	default:
		return fmt.Errorf("watchtower answered %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
}
