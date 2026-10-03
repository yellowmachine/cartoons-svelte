# jellyfin-bridge

A small HTTP service that runs at home next to Jellyfin and exposes a **closed
set** of Jellyfin actions to the Cartoons backend on the VPS, through a
Cloudflare tunnel.

- The Jellyfin API key stays at home. The VPS only holds this bridge's token,
  so a compromised VPS can list libraries, rebuild one playlist and start
  playback, but it can't administer Jellyfin.
- No endpoint forwards raw Jellyfin calls. Every action is a typed endpoint
  with validated input: ids must look like Jellyfin ids, and bodies are
  size-limited and reject unknown fields.
- The only thing it can delete is the user's playlists named `PLAYLIST_NAME`.
- It only commands sessions that the configured user can control.
- It uses only the Go standard library, so there are no third-party dependencies.

```
VPS (cartoons) ──HTTPS──▶ Cloudflare Access ──tunnel──▶ cloudflared ──▶ jellyfin-bridge ──▶ jellyfin:8096
```

## Configuration

| Variable                | Default                  | Notes                                                                             |
| ----------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `API_TOKEN`             | —                        | **Required**, at least 32 characters (`openssl rand -hex 32`).                    |
| `API_TOKEN_FILE`        | —                        | Read the token from a file (Docker secrets). Use one or the other.                |
| `JELLYFIN_URL`          | —                        | **Required**. Jellyfin as seen from the bridge, e.g. `http://jellyfin:8096`.      |
| `JELLYFIN_USER_ID`      | —                        | **Required**. The user whose libraries, playlists and sessions are used.          |
| `JELLYFIN_API_KEY`      | —                        | **Required**. Dashboard → API Keys.                                               |
| `JELLYFIN_API_KEY_FILE` | —                        | Read the API key from a file. Use one or the other.                               |
| `PLAYLIST_NAME`         | `Para ver hoy`           | The playlist that `PUT /playlist` replaces.                                       |
| `LISTEN_ADDR`           | `127.0.0.1:8787`         | Use `0.0.0.0:8787` inside compose, with no `ports:` published.                    |
| `LOG_LEVEL`             | `info`                   | `debug` also logs `/healthz` requests.                                            |
| `UPDATE_TOKEN`          | —                        | Enables `POST /admin/update`. At least 32 characters, different from `API_TOKEN`. |
| `UPDATE_TOKEN_FILE`     | —                        | Read it from a file. Use one or the other.                                        |
| `WATCHTOWER_URL`        | `http://watchtower:8080` | Watchtower's HTTP API, on the internal network. Only with `UPDATE_TOKEN`.         |
| `WATCHTOWER_TOKEN`      | —                        | Watchtower's `WATCHTOWER_HTTP_API_TOKEN`. Required with `UPDATE_TOKEN`.           |
| `WATCHTOWER_TOKEN_FILE` | —                        | Read it from a file. Use one or the other.                                        |

## Endpoints

All endpoints except `GET /healthz` require `Authorization: Bearer <token>`.
Ids are Jellyfin ids (32 hex characters). Errors are returned as `{"error": "..."}`:

| Status | Meaning                                                             |
| ------ | ------------------------------------------------------------------- |
| 400    | Invalid input                                                       |
| 401    | Missing or wrong token                                              |
| 404    | No such item or folder, or a session the user can't control         |
| 413    | Body larger than 64 KB                                              |
| 502    | Jellyfin answered with an error (or rejected the API key; see logs) |
| 503    | Jellyfin is not reachable                                           |
| 504    | Jellyfin took longer than 30 s                                      |

| Method | Path                                | Body / answer                                                                                              |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET    | `/healthz`                          | → `{ok, jellyfin}`; always 200 while the bridge runs                                                       |
| GET    | `/folders`                          | → `[{id, name}]`, the user's libraries                                                                     |
| GET    | `/folders/{id}/items?unplayed=true` | → `[{id, name, series_name?, sort_name?, season?, episode?, has_image}]`, movies and episodes, recursively |
| PUT    | `/playlist`                         | `{"item_ids": [...1-200]}` → `{id}`. Deletes the `PLAYLIST_NAME` playlist(s) and creates it again          |
| GET    | `/sessions`                         | → `[{id, device_name, client}]`, the sessions the user can remote-control                                  |
| POST   | `/sessions/{id}/play`               | `{"item_ids": [...1-200]}` → `204`. Plays now on that session                                              |
| GET    | `/items/{id}/image`                 | → the item's primary image, at most 400 px tall                                                            |

**Update webhook.** `POST /admin/update` exists only when `UPDATE_TOKEN` is set,
and takes that token instead of `API_TOKEN`: the app's token can't call it, and
this token can't call anything else. It takes no input. It asks Watchtower to
check for new images of the containers labelled
`com.centurylinklabs.watchtower.enable=true` and answers `202` once Watchtower
has started, before it restarts the bridge. `409` means an update is already
running, and `503` means Watchtower isn't reachable.

### Examples

```sh
B=https://jellyfin-bridge.example.com
AUTH=(-H "Authorization: Bearer $API_TOKEN"
      -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID"
      -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")

curl "${AUTH[@]}" $B/folders
curl "${AUTH[@]}" "$B/folders/<id>/items?unplayed=true"
curl "${AUTH[@]}" -X PUT $B/playlist -d '{"item_ids": ["<id>", "<id>"]}'
curl "${AUTH[@]}" -X POST $B/sessions/<id>/play -d '{"item_ids": ["<id>"]}'
```

## Deployment at home

`docker-compose.home.yml` at the repo root runs this bridge, with no
published ports, plus `cloudflared` and Watchtower. Put these in `.env`, next to that file:

```env
JELLYFIN_URL=http://host.docker.internal:8096
JELLYFIN_USER_ID=<user id>
JELLYFIN_API_KEY=<API key>
BRIDGE_API_TOKEN=<openssl rand -hex 32>
CLOUDFLARE_TUNNEL_TOKEN=<tunnel token>
BRIDGE_UPDATE_TOKEN=<openssl rand -hex 32>
WATCHTOWER_TOKEN=<openssl rand -hex 32>
```

`host.docker.internal` reaches a Jellyfin running on the host itself. If
Jellyfin runs in Docker, put both on the same network and use its service name.

### Cloudflare setup

1. **Tunnel.** Go to Zero Trust → Networks → Tunnels and create a tunnel of type
   _Cloudflared_. Copy its token into `CLOUDFLARE_TUNNEL_TOKEN`. Add a
   _public hostname_, for example `jellyfin-bridge.example.com`, with service
   `http://jellyfin-bridge:8787`.
2. **Service token.** Go to Zero Trust → Access → Service Auth → Service Tokens
   and create one. Keep its Client ID and Secret for the app on the VPS.
3. **Access application.** Go to Zero Trust → Access → Applications and add a
   _Self-hosted_ application for `jellyfin-bridge.example.com`. Give it a single
   policy with **Action: Service Auth** and **Include: Service Token = (the token above)**.
   Browsers get blocked, and only requests that carry
   `CF-Access-Client-Id` / `CF-Access-Client-Secret` get through.

If you already have a tunnel at home (for example the one for `mpd-bridge`),
you can add this hostname to it instead of running a second `cloudflared`, and
reuse the same service token by adding it to this application's policy.

On the VPS, the app needs `JELLYFIN_BRIDGE_URL`, `JELLYFIN_BRIDGE_TOKEN` (the
bridge's `API_TOKEN`) and the two `CF_ACCESS_*` values.

### Automatic updates

```
CI ──▶ Cloudflare Access ──tunnel──▶ jellyfin-bridge  POST /admin/update
                                          │  (compose network)
                                          ▼
                                     watchtower :8080  ──▶ pulls from GHCR, restarts the bridge
```

On every push to `main` that touches `jellyfin-bridge/`, the
`jellyfin-bridge.yml` workflow publishes the image, waits until `:latest`
resolves to the new digest, and calls `POST /admin/update`. Watchtower runs
[`nickfedor/watchtower`](https://github.com/nicholas-fedor/watchtower), the
maintained fork, since `containrrr/watchtower` was archived in 2025. It is the
only container with the Docker socket. It has no ports and no tunnel route, so
only the bridge can reach it, and it only touches labelled containers. As a
fallback, it also checks for new images once a day.

The workflow needs these repository secrets. Without the first two, it skips
the call:

- `JELLYFIN_BRIDGE_URL`: the tunnel hostname.
- `JELLYFIN_BRIDGE_UPDATE_TOKEN`: the same value as `BRIDGE_UPDATE_TOKEN` at home.
- `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`: a service token allowed by
  the Access application. A separate one for CI is best, so you can revoke it on its own.

The image in GHCR must be public, or Watchtower needs registry credentials to pull it.

### Rotating the token

1. Generate a new token.
2. Update `BRIDGE_API_TOKEN` at home and run `docker compose -f docker-compose.home.yml up -d jellyfin-bridge`.
3. Update the app's `JELLYFIN_BRIDGE_TOKEN` on the VPS.

Requests fail with 401 in the short gap between steps 2 and 3.

## Development

```sh
go test -race ./...
API_TOKEN=$(openssl rand -hex 32) JELLYFIN_URL=http://localhost:8096 \
  JELLYFIN_USER_ID=<id> JELLYFIN_API_KEY=<key> go run ./cmd/jellyfin-bridge
```

Or, from the repo root, `docker compose up --build` runs the app and the
bridge together, both reading `.env`.

Layout:

- `cmd/jellyfin-bridge`: entry point and the `healthcheck` subcommand.
- `internal/jellyfin`: the Jellyfin API client.
- `internal/httpapi`: routes and validation.
- `internal/watchtower`: triggers Watchtower updates.
- `internal/auth`: bearer-token middleware.
- `internal/config`: environment variables.
