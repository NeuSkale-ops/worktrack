# WorkTrack

Windows-first time tracking for a remote team, with a React dashboard and Go API hosted on Hetzner.

## Scope

- 20+ workers, on company and personal Windows PCs.
- Visible Start/Stop tracking, with screenshots every 10 elapsed minutes while tracking runs.
- No projects, keystroke content, hidden monitoring, or capture outside tracking sessions.
- Private screenshots, role-restricted timelines, hours reports and CSV export.

## Layout

- `agent/`: Tauri Windows desktop app, Rust core and React interface.
- `server/`: Go API, PostgreSQL schema and authentication.
- `web/`: React and TypeScript dashboard built with Vite.
- `deploy/`: Docker Compose, Caddy HTTPS and Hetzner deployment guide.
- `docs/RESEARCH.md`: research and earlier design decisions.

## Status

Initial V1 source is implemented and pushed.
The dashboard, API and portable agent tests have passed local checks.
See `docs/VALIDATION.md` for observed results and remaining release gates.
Do not deploy to workers until Windows capture, lock/suspend handling, installation, authorization and backup restoration have been tested end to end.
The current implementation and component READMEs take precedence over earlier research proposals.
Screenshots follow a fixed 10-minute elapsed interval, not randomized clock windows.

## Privacy

Workers must receive a clear monitoring notice and explicitly start tracking.
Personal activity outside tracking must not be collected.
Activity measurements are input activity, not proof of productivity.
Do not automatically deduct wages because a screenshot was removed or a worker was reading without typing.
Use a published retention period and a legally reviewed employment policy before rollout.

## Deployment

Application services and data are intended to stay on Hetzner.
GitHub hosts source and CI builds, not worker data.
No live Hetzner infrastructure is created by this repository.
See `server/README.md`, `web/README.md`, `agent/README.md` and `deploy/README.md` for component setup.
In production, Caddy serves the built React dashboard and proxies `/api/*` to Go.
PostgreSQL is private to the Docker network.
The initial desktop release intentionally leaves autostart and auto-update disabled.

Keep all credentials out of git.
On the developer machine, use envkit for secrets.
