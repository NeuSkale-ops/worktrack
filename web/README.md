# WorkTrack dashboard

React, TypeScript, Vite, and plain CSS.
All dashboard data comes from the Go API documented in `../server/API.md`.
There is no demo mode or bundled sample data.

## Run locally

Requires Node.js 22.18+ and pnpm 12.
Start the Go API with `APP_ORIGIN=http://localhost:5173` and its database/storage configuration.
Then run:

```sh
cd web
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:5173` and use a server-provisioned account.
The development server proxies `/api` to `http://127.0.0.1:8080`.
Set `API_PROXY_TARGET` to use a different API address:

```sh
API_PROXY_TARGET=http://127.0.0.1:18089 pnpm dev
```

Production requests use the same origin as the dashboard.
Serve `dist/` alongside `/api`, with an SPA fallback for invitation URLs such as `/invite?token=...`.
Do not expose API secrets through Vite environment variables.

## Validate

```sh
pnpm typecheck
pnpm test
pnpm build
```

Tests cover UTC dates, Monday-based weeks, time formatting, activity calculations, cookie credentials, JSON requests, and API errors.
Network responses are stubbed only in isolated client tests, never in the application.

## Behavior

- Owners and managers can see the team, live tracking status, timelines, and weekly timesheets, and create private worker invitation links.
- Workers see only their own timeline and hours.
- Status, timeline URLs, and hours refresh every 30 seconds while the tab is visible.
- Reporting dates and timeline times are UTC, matching the API.
- The selected date chooses the Monday-to-Sunday reporting week and CSV export range.
- A stale unfinished session can be recovered for the signed-in user after two minutes without a heartbeat. This requires confirmation and is only for a lost computer or app data. Stop and sync the original computer if available, since recovery can prevent its remaining queued records from syncing.
- Screenshot deletion keeps recorded time, while time-block deletion deducts hours.
  Both require explicit confirmation and are available only for the signed-in person's own blocks.
- Browser authentication uses the API's HttpOnly session cookie.
  No credentials or tokens are saved to browser storage.
- Native labels, table headers, keyboard focus styles, and the screenshot dialog support keyboard and screen-reader navigation.
