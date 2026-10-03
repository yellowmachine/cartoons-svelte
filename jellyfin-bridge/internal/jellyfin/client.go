// Package jellyfin is a client for the small part of the Jellyfin API the
// bridge exposes. Every call runs as one configured user.
package jellyfin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const itemTypes = "Movie,Episode,Video"

var (
	// ErrUnavailable means Jellyfin could not be reached.
	ErrUnavailable = errors.New("jellyfin unavailable")
	// ErrRejected means Jellyfin answered 401/403: the API key is wrong or revoked.
	ErrRejected = errors.New("jellyfin rejected the API key")
	// ErrNotFound means the item, folder or session does not exist (for this user).
	ErrNotFound = errors.New("not found")
)

// StatusError is any other non-2xx answer from Jellyfin.
type StatusError struct {
	Path   string
	Status int
	Body   string
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("jellyfin %s answered %d: %s", e.Path, e.Status, e.Body)
}

type Folder struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Item struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	SeriesName string `json:"series_name,omitempty"`
	SortName   string `json:"sort_name,omitempty"`
	Season     *int   `json:"season,omitempty"`
	Episode    *int   `json:"episode,omitempty"`
	HasImage   bool   `json:"has_image"`
}

type Session struct {
	ID         string `json:"id"`
	DeviceName string `json:"device_name"`
	Client     string `json:"client"`
}

// Image is an item's primary image. The caller must close Body.
type Image struct {
	ContentType string
	Length      int64 // -1 when unknown
	Body        io.ReadCloser
}

type Config struct {
	URL          string // without a trailing slash
	APIKey       string
	UserID       string
	PlaylistName string
	HTTPClient   *http.Client // optional
}

type Client struct {
	cfg  Config
	http *http.Client
}

func New(cfg Config) *Client {
	hc := cfg.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{cfg: cfg, http: hc}
}

// ValidID reports whether s looks like a Jellyfin id: 32 hex characters,
// optionally in dashed GUID form.
func ValidID(s string) bool {
	s = strings.ReplaceAll(s, "-", "")
	if len(s) != 32 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

func (c *Client) do(ctx context.Context, method, path string, query url.Values, body any) (*http.Response, error) {
	target := c.cfg.URL + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", `MediaBrowser Token="`+c.cfg.APIKey+`"`)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return resp, nil
	}

	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return nil, ErrRejected
	case http.StatusNotFound:
		return nil, ErrNotFound
	}
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	return nil, &StatusError{Path: path, Status: resp.StatusCode, Body: strings.TrimSpace(string(msg))}
}

// call runs a request and decodes a JSON answer into out, if out is not nil.
func (c *Client) call(ctx context.Context, method, path string, query url.Values, body, out any) error {
	resp, err := c.do(ctx, method, path, query, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if out == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("jellyfin %s: decoding answer: %w", path, err)
	}
	return nil
}

type jfItem struct {
	ID                string            `json:"Id"`
	Name              string            `json:"Name"`
	SeriesName        string            `json:"SeriesName"`
	SortName          string            `json:"SortName"`
	ParentIndexNumber *int              `json:"ParentIndexNumber"`
	IndexNumber       *int              `json:"IndexNumber"`
	ImageTags         map[string]string `json:"ImageTags"`
}

type jfItems struct {
	Items []jfItem `json:"Items"`
}

// Ping checks that Jellyfin answers at all.
func (c *Client) Ping(ctx context.Context) error {
	return c.call(ctx, http.MethodGet, "/System/Ping", nil, nil, nil)
}

// Folders lists the user's libraries (Views).
func (c *Client) Folders(ctx context.Context) ([]Folder, error) {
	var res jfItems
	if err := c.call(ctx, http.MethodGet, "/Users/"+c.cfg.UserID+"/Views", nil, nil, &res); err != nil {
		return nil, err
	}
	folders := make([]Folder, 0, len(res.Items))
	for _, it := range res.Items {
		folders = append(folders, Folder{ID: it.ID, Name: it.Name})
	}
	return folders, nil
}

// FolderItems lists the playable items under a folder, recursively.
func (c *Client) FolderItems(ctx context.Context, folderID string, unplayedOnly bool) ([]Item, error) {
	q := url.Values{
		"ParentId":         {folderID},
		"Recursive":        {"true"},
		"IncludeItemTypes": {itemTypes},
		"Fields":           {"SeriesName,SortName,ImageTags"},
	}
	if unplayedOnly {
		q.Set("Filters", "IsUnplayed")
	}
	var res jfItems
	if err := c.call(ctx, http.MethodGet, "/Users/"+c.cfg.UserID+"/Items", q, nil, &res); err != nil {
		return nil, err
	}
	items := make([]Item, 0, len(res.Items))
	for _, it := range res.Items {
		items = append(items, Item{
			ID:         it.ID,
			Name:       it.Name,
			SeriesName: it.SeriesName,
			SortName:   it.SortName,
			Season:     it.ParentIndexNumber,
			Episode:    it.IndexNumber,
			HasImage:   it.ImageTags["Primary"] != "",
		})
	}
	return items, nil
}

// ReplacePlaylist deletes the user's playlists named PlaylistName and
// creates a new one with itemIDs, returning its id. It is the only way the
// bridge deletes anything, and it can only delete those playlists.
func (c *Client) ReplacePlaylist(ctx context.Context, itemIDs []string) (string, error) {
	q := url.Values{
		"IncludeItemTypes": {"Playlist"},
		"Recursive":        {"true"},
		"SearchTerm":       {c.cfg.PlaylistName},
	}
	var existing jfItems
	if err := c.call(ctx, http.MethodGet, "/Users/"+c.cfg.UserID+"/Items", q, nil, &existing); err != nil {
		return "", err
	}
	for _, it := range existing.Items {
		if it.Name != c.cfg.PlaylistName || !ValidID(it.ID) {
			continue
		}
		err := c.call(ctx, http.MethodDelete, "/Items/"+it.ID, nil, nil, nil)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return "", err
		}
	}

	var created struct {
		ID string `json:"Id"`
	}
	body := map[string]any{
		"Name":      c.cfg.PlaylistName,
		"Ids":       itemIDs,
		"UserId":    c.cfg.UserID,
		"MediaType": "Video",
	}
	if err := c.call(ctx, http.MethodPost, "/Playlists", nil, body, &created); err != nil {
		return "", err
	}
	return created.ID, nil
}

type jfSession struct {
	ID                    string `json:"Id"`
	DeviceName            string `json:"DeviceName"`
	Client                string `json:"Client"`
	SupportsRemoteControl bool   `json:"SupportsRemoteControl"`
}

// Sessions lists the sessions the user can remote-control right now.
func (c *Client) Sessions(ctx context.Context) ([]Session, error) {
	var res []jfSession
	q := url.Values{"ControllableByUserId": {c.cfg.UserID}}
	if err := c.call(ctx, http.MethodGet, "/Sessions", q, nil, &res); err != nil {
		return nil, err
	}
	sessions := make([]Session, 0, len(res))
	for _, s := range res {
		if s.SupportsRemoteControl {
			sessions = append(sessions, Session{ID: s.ID, DeviceName: s.DeviceName, Client: s.Client})
		}
	}
	return sessions, nil
}

// Play starts itemIDs on a session. The API key could command any session,
// so the session must be one that Sessions returns; otherwise ErrNotFound.
func (c *Client) Play(ctx context.Context, sessionID string, itemIDs []string) error {
	sessions, err := c.Sessions(ctx)
	if err != nil {
		return err
	}
	found := false
	for _, s := range sessions {
		if s.ID == sessionID {
			found = true
			break
		}
	}
	if !found {
		return ErrNotFound
	}
	q := url.Values{"PlayCommand": {"PlayNow"}, "ItemIds": {strings.Join(itemIDs, ",")}}
	return c.call(ctx, http.MethodPost, "/Sessions/"+url.PathEscape(sessionID)+"/Playing", q, nil, nil)
}

// Image fetches an item's primary image, scaled down for thumbnails.
func (c *Client) Image(ctx context.Context, itemID string) (*Image, error) {
	q := url.Values{"maxHeight": {"400"}, "quality": {"90"}}
	resp, err := c.do(ctx, http.MethodGet, "/Items/"+itemID+"/Images/Primary", q, nil)
	if err != nil {
		return nil, err
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "image/") {
		resp.Body.Close()
		return nil, &StatusError{Path: "/Items/{id}/Images/Primary", Status: resp.StatusCode, Body: "unexpected content type " + ct}
	}
	return &Image{ContentType: ct, Length: resp.ContentLength, Body: resp.Body}, nil
}
