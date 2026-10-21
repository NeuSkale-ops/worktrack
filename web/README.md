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

For dependency-free browser checks, run `pnpm dev --port 1428` and open `/tests/diagnostics.html?role=owner`, then repeat with `role=manager` and `role=worker`.
For visual review with sample data, open `/tests/preview.html?role=owner`, `?role=worker`, or `?auth=1` for sign-in.
Managers and owners see **Who worked when**: one ribbon per person for the selected local day, built from `GET /api/reports/day`. Select a row to load that person's screenshots and applications.
The harness renders the real dashboard with mocked API responses and exposes `document.documentElement.dataset.testResult` as `passed` or `failed`.
It checks explicit loading, role visibility, escaped names, empty results, failure recovery, application-minute aggregation, zero coordinates/accuracy, missing location states, and the screenshot dialog's linked location. These fixtures are not included in the production build and do not test native Windows behavior.

## Screenshot location and application minutes

Each timeline screenshot can show its required coordinate fix, accuracy, and fix timestamp, or a clear unavailable status (older clients may report sharing off). The screenshot dialog repeats its associated location. No map provider is contacted automatically.
**Applications on selected day** sums foreground executable milliseconds from the selected worker's time blocks starting on that UTC date. It includes idle time and is an estimate, not a productivity score. Older agents have no historical application/location data; hosted apps may share an executable and inaccessible processes appear as Unknown.
Workers see their own data; managers/owners can see team timelines. Deleting a screenshot also removes its location; deleting a time block removes app usage and location from the live database.

## Behavior

- Owners and managers can see the team, live tracking status, timelines, and weekly timesheets, and create private worker invitation links.
- Only owners see **Desktop diagnostic logs (owner only)** below the timesheet. Expand it and click **Load recent logs** for the newest 100 desktop events from the last seven days. It does not fetch automatically. Managers/workers have no diagnostic panel, and the API independently enforces owner access.
- Workers see only their own timeline and hours.
- Status, timeline URLs, and hours refresh every 30 seconds while the tab is visible.
- Time-only blocks are not failed screenshots. Timeline labels distinguish no capture, deliberate deletion, and temporary storage unavailability; normal blocks upload about every 30 seconds, screenshots every ten running minutes. Location labels are omitted for time-only/deleted screenshots.
- Reporting dates and timeline times are UTC, matching the API.
- The selected date chooses the Monday-to-Sunday reporting week and CSV export range.
- A stale unfinished session can be recovered for the signed-in user after two minutes without a heartbeat. This requires confirmation and is only for a lost computer or app data. Stop and sync the original computer if available, since recovery can prevent its remaining queued records from syncing.
- Screenshot deletion keeps recorded time, while time-block deletion deducts hours.
  Both require explicit confirmation and are available only for the signed-in person's own blocks.
- Browser authentication uses the API's HttpOnly session cookie.
  No credentials or tokens are saved to browser storage.
- Native labels, table headers, keyboard focus styles, and the screenshot dialog support keyboard and screen-reader navigation.
