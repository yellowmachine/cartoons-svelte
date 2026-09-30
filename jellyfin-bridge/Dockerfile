# syntax=docker/dockerfile:1

# Build on the runner's native platform and cross-compile for the target, so
# multi-arch builds need no QEMU emulation.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/jellyfin-bridge ./cmd/jellyfin-bridge

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /out/jellyfin-bridge /jellyfin-bridge
USER nonroot:nonroot
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["/jellyfin-bridge", "healthcheck"]
ENTRYPOINT ["/jellyfin-bridge"]
