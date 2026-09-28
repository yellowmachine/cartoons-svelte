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

- `JELLYFIN_URL`: URL base de tu servidor, sin barra final (p. ej. `http://jellyfin.local:8096`).
- `JELLYFIN_USER_ID`: id del usuario Jellyfin cuya biblioteca/sesiones se usan. Se obtiene en
  Panel de administración → Usuarios → (tu usuario), está en la URL.
- `JELLYFIN_API_KEY`: se genera en Panel de administración → API Keys → "+".
- `ORIGIN`: URL pública donde sirves la app (SvelteKit la necesita en producción).
- `ADMIN_PASSWORD`: si la defines, la app pide esta contraseña antes de dejar entrar (una cookie
  de 10 años recuerda la sesión). Recomendado si el dominio es accesible desde internet, como
  `cartoons.scholio.review`. Vacío o sin definir = sin contraseña.

Estas variables se leen en **runtime**, no en build time — puedes cambiarlas sin reconstruir la
imagen, solo reiniciando el contenedor.

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

Sirve la app en `http://localhost:3000`, leyendo las variables de `.env`.

## CI/CD

- **`.github/workflows/ci.yml`**: en cada push/PR corre type-check, lint y build.
- **`.github/workflows/build-deploy.yml`**: en push a `main`, construye la imagen multi-arquitectura
  (`linux/amd64` + `linux/arm64`) y la publica en GHCR (`ghcr.io/<owner>/<repo>`), y dispara el
  webhook de deploy de Dokploy.

Secreto necesario en el repo de GitHub (Settings → Secrets and variables → Actions):

- `DOKPLOY_WEBHOOK_URL`: URL del webhook de deploy de la aplicación en Dokploy (se genera en la
  configuración de deploy → "Custom Git" o el webhook de tu app).

En Dokploy la app se configura como **Application** (no como Compose) apuntando a la imagen
`ghcr.io/<owner>/<repo>:latest` con `pull_policy: always`, puerto interno **3000**, y las
variables de entorno `JELLYFIN_URL`, `JELLYFIN_USER_ID`, `JELLYFIN_API_KEY` y `ORIGIN` (esta
última con el dominio público que le asignes). No hace falta publicar/exponer el puerto al host:
Traefik llega al contenedor por la red interna que gestiona Dokploy — `compose.yaml` no
interviene en este flujo, es solo para desarrollo local.
