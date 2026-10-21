# syntax=docker/dockerfile:1
FROM node:22-alpine AS dashboard-build
WORKDIR /src/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM golang:1.24-alpine AS api-build
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api .

FROM alpine:3.22 AS api
RUN apk add --no-cache ca-certificates wget && addgroup -S -g 10001 app && adduser -S -D -H -u 10001 -G app app
COPY --from=api-build /out/api /usr/local/bin/api
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/api"]

FROM caddy:2-alpine AS web
COPY --from=dashboard-build /src/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
RUN setcap -r /usr/bin/caddy && mkdir -p /data /config && chown -R 10001:10001 /data /config
USER 10001:10001
EXPOSE 8080 8443
