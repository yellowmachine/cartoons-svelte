# 📺 Cartoons

Frontend sencillo sobre un servidor Jellyfin: marca las carpetas que quieres ver, pide 10
episodios/películas al azar sin ver, se crea (o reemplaza) la playlist **"Para ver hoy"** y la
lanzas directamente en cualquier cliente Jellyfin abierto en ese momento.

SvelteKit + Bun + Tailwind CSS.

## Cómo funciona

1. Al entrar se listan las bibliotecas (Views) de tu Jellyfin como carpetas: la app asume que
   cada biblioteca es ya una serie/colección propia (p.ej. una biblioteca por dibujo animado),
   no una biblioteca grande con varias series dentro.
2. Marcas las que te interesan y pulsas **"🎲 10 al azar"**. El servidor busca items sin ver en
   esas carpetas (como mucho 2 por carpeta, para que una con muchísimo contenido no se coma el
   resultado) y propone 10 al azar, cada uno marcado por defecto.
3. Puedes desmarcar los que no te apetezcan hoy y pulsar **"✅ Crear Para ver hoy"**: ahí es
   cuando de verdad se borra la playlist "Para ver hoy" si ya existía y se crea una nueva con
   los items que sigan marcados.
4. Se muestran los clientes Jellyfin conectados en ese momento, uno por botón
   ("Play en salón", "Play en tele habitación"…). Al pulsar uno, se manda la orden de reproducir
   esos items ahí mismo.

## Instalar como app (PWA)

La app tiene manifest e icono, así que Brave (y Chrome) ofrecen instalarla como aplicación:
abre la URL, y en la barra de direcciones pulsa el icono de instalar (o menú → "Instalar
Cartoons…"). Si cambias `static/icon.svg`, regenera los iconos con `bun run pwa:icons`.

## Configuración

Copia `.env.example` a `.env` y rellena:

```sh
cp .env.example .env
```

La app no habla con Jellyfin directamente, sino con [`jellyfin-bridge`](jellyfin-bridge/README.md),
un servicio pequeño que corre en casa junto a Jellyfin y al que el VPS llega por un túnel de
Cloudflare. La API key de Jellyfin se queda en casa: el VPS solo tiene el token del bridge.

```
VPS (cartoons) ──HTTPS──▶ Cloudflare Access ──túnel──▶ cloudflared ──▶ jellyfin-bridge ──▶ Jellyfin
```

Variables de la app:

- `JELLYFIN_BRIDGE_URL`: URL del bridge (el hostname del túnel), sin barra final.
- `JELLYFIN_BRIDGE_TOKEN`: el `API_TOKEN` del bridge (`openssl rand -hex 32`).
- `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`: service token de Cloudflare Access que
  protege el bridge.
- `ORIGIN`: URL pública donde sirves la app (SvelteKit la necesita en producción).
- `ADMIN_PASSWORD`: si la defines, la app pide esta contraseña antes de dejar entrar (una cookie
  de 10 años recuerda la sesión). Recomendado si el dominio es accesible desde internet, como
  `cartoons.scholio.review`. Vacío o sin definir = sin contraseña.

Variables del bridge (en casa, nunca en el VPS):

- `JELLYFIN_URL`: URL de Jellyfin vista desde el bridge, sin barra final.
- `JELLYFIN_USER_ID`: id del usuario Jellyfin cuya biblioteca/sesiones se usan. Se obtiene en
  Panel de administración → Usuarios → (tu usuario), está en la URL.
- `JELLYFIN_API_KEY`: se genera en Panel de administración → API Keys → "+".

Estas variables se leen en **runtime**, no en build time — puedes cambiarlas sin reconstruir la
imagen, solo reiniciando el contenedor.

### En casa

`docker-compose.home.yml` levanta el bridge (sin puertos publicados) y `cloudflared`. Los pasos
para crear el túnel, el service token y la aplicación de Cloudflare Access están en
[`jellyfin-bridge/README.md`](jellyfin-bridge/README.md#cloudflare-setup).

```sh
docker compose -f docker-compose.home.yml up -d
```

## Desarrollo

```sh
bun install
bun run dev -- --open
```

## Comandos

- `bun run dev` — servidor de desarrollo
- `bun run build` / `bun run preview` — build de producción y previsualización
- `bun run check` — chequeo de tipos
- `bun run lint` / `bun run format` — lint y formateo (ESLint + Prettier)

## Docker (local)

`compose.yaml` es solo para probar la imagen en tu máquina — **no** es lo que usa Dokploy en
producción (ver más abajo):

```sh
docker compose up --build
```

Levanta la app en `http://localhost:3000` y un `jellyfin-bridge` local, ambos leyendo las variables
de `.env` (la app apunta al bridge local, ignorando `JELLYFIN_BRIDGE_URL`).

## CI/CD

- **`.github/workflows/ci.yml`**: en cada push/PR corre type-check, lint y build.
- **`.github/workflows/jellyfin-bridge.yml`**: cuando cambia `jellyfin-bridge/`, corre gofmt, vet y
  tests; en push a `main` publica `ghcr.io/<owner>/<repo>-jellyfin-bridge` (amd64 + arm64).
- **`.github/workflows/build-deploy.yml`**: en push a `main`, construye la imagen multi-arquitectura
  (`linux/amd64` + `linux/arm64`) y la publica en GHCR (`ghcr.io/<owner>/<repo>`), y dispara el
  webhook de deploy de Dokploy.

Secreto necesario en el repo de GitHub (Settings → Secrets and variables → Actions):

- `DOKPLOY_WEBHOOK_URL`: URL del webhook de deploy de la aplicación en Dokploy (se genera en la
  configuración de deploy → "Custom Git" o el webhook de tu app).

En Dokploy la app se configura como **Application** (no como Compose) apuntando a la imagen
`ghcr.io/<owner>/<repo>:latest` con `pull_policy: always`, puerto interno **3000**, y las
variables de entorno `JELLYFIN_BRIDGE_URL`, `JELLYFIN_BRIDGE_TOKEN`, `CF_ACCESS_CLIENT_ID`,
`CF_ACCESS_CLIENT_SECRET`, `ADMIN_PASSWORD` y `ORIGIN` (esta última con el dominio público que le
asignes). No hace falta publicar/exponer el puerto al host:
Traefik llega al contenedor por la red interna que gestiona Dokploy — `compose.yaml` no
interviene en este flujo, es solo para desarrollo local.
