# ─── Stage 1: deps ─────────────────────────────────────────────────────────
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ─── Stage 2: build ────────────────────────────────────────────────────────
FROM oven/bun:1 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Vars mínimas para que el build de SvelteKit no falle; los valores reales
# de Jellyfin se leen en runtime vía $env/dynamic/private.
ENV ORIGIN=https://placeholder.local

RUN bun run build

# ─── Stage 3: prod ─────────────────────────────────────────────────────────
# svelte-adapter-bun genera un servidor que corre con Bun.
FROM oven/bun:1-slim AS prod
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 3000

CMD ["bun", "./build/index.js"]
