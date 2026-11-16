# WorkTrack

Windows-first time tracking with screenshots, a Go API and a React dashboard on Hetzner. Read `README.md` (scope, privacy) and the component READMEs before changing behavior.

## Layout

- `server/`: Go API, migrations in `server/migrations`, API reference in `server/API.md`.
- `web/`: React 19 and TypeScript dashboard (Vite, pnpm).
- `agent/`: Tauri desktop app (Rust core in `src-tauri/`, React UI).
- `agent/managed/`: separate disclosed monitoring agent for company-owned laptops (Intune, Windows service).
- `deploy/`: Docker Compose, Caddy, Hetzner guide. `scripts/`: acceptance and updater scripts.

## Commands

- Server: `cd server && go test ./...`.
- Web: `cd web && pnpm typecheck && pnpm test && pnpm build`.
- Agent: `cd agent && pnpm build`, `cd agent/src-tauri && cargo test`.
- Run anything needing secrets with `envkit run -- <cmd>`.

## Rules

- Privacy constraints in `README.md` are requirements. Never capture outside tracking sessions, window titles, keystrokes, full paths or continuous location. Managed agent must stay visible, never stealthy.
- Screenshot interval is a fixed 10 elapsed minutes.
- Ship by pushing the `deploy` branch. CI builds images and bumps `infra/apps/neuskale/worktrack`. Migrations run at API startup.
- See `docs/VALIDATION.md` for release gates before deploying to workers.
