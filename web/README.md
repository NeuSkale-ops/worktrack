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

Tests cover UTC dates, Monday-based weeks, time formatting, activity calculations, ribbon grouping and zoom, cookie credentials, JSON requests, and API errors.
Network responses are stubbed only in isolated client tests, never in the application.

For dependency-free browser checks, run `pnpm dev --port 1428` and open `/tests/diagnostics.html?role=owner`, then repeat with `role=manager` and `role=worker`.
For visual review with sample data, open `/tests/preview.html?role=owner`, `?role=worker`, or `?auth=1` for sign-in.
Managers and owners land on **Team today**, a board with one ribbon of recorded time per person and, under each person, a grey ribbon of active time for every company laptop assigned to them. Clicking a person opens their day, which uses `GET /api/timeline`; the board uses `GET /api/reports/day` and `GET /api/reports/device-day`. Workers land on **My hours**, a week table of their own recorded hours with CSV export. They see no screenshots, applications or activity details, cannot delete anything, and never see or request laptop activity. **Open** on the Devices page, or a laptop line on the board, opens that laptop's own page. It is laid out like a person's day (totals, a ribbon of active time, screenshots by hour) with tabs for applications, session events and capture settings, and uses `GET /api/devices/{id}/activity`.
**Screenshots** opens by default on a day. **Activity details** lists every uploaded interval with exact seconds, and **Applications** shows foreground-time estimates. **Week** contains the timesheet and CSV export. **People** holds roles, organisations, invitations and access controls. **Devices** lists company laptops with an **Assigned to** selector, and holds the owner-only **Desktop app diagnostics** tab. **Settings** contains desktop downloads, record retention notes and password changes.
The harness renders the real dashboard with mocked API responses and exposes `document.documentElement.dataset.testResult` as `passed` or `failed`.
It checks the team board, screenshot-first navigation, that one person's screenshots never show under another name, keyboard tabs, role visibility, escaped names, empty days, stale-data errors and recovery, failed-image refresh, exact interval durations, application-minute aggregation, zero coordinates/accuracy and the screenshot dialog's linked location. These fixtures are not included in the production build and do not test native Windows behavior.

## Screenshot location and application minutes

Screenshot previews show the image and capture time without exposing coordinates on the main page. **View details** shows the associated coordinate fix, accuracy and fix timestamp, or an explicit unavailable/sharing-off state. No map provider is contacted automatically.
**Applications** sums foreground executable milliseconds from the selected person's time blocks starting on the selected local day. It includes idle time and is an estimate, not a productivity score. Older agents have no historical application/location data; hosted apps may share an executable and inaccessible processes appear as Unknown.
Workers see only their recorded hours; managers/owners can see team timelines. Deleting a screenshot also removes its location; deleting a time block removes app usage and location from the live database.

## Behavior

- Owners and managers can see the team, live tracking status, timelines, and weekly timesheets, and create private worker invitation links.
- Each company laptop belongs to an organisation, chosen by an owner on the Devices page. That organisation's managers see the laptop, with or without a person assigned. A laptop in no organisation is visible to owners only, and new laptops start that way.
- Owners and managers can assign a company laptop to a person on the Devices page. The person must be in the laptop's organisation, or be an owner. Managers cannot unassign. Laptop activity from before a reassignment or a change of organisation is not shown to the new person or the new managers.
- The day ribbon shows 06:00 to 22:00 by default and switches to the full day by itself when time was recorded outside that window.
- Only owners see the **Desktop app diagnostics** tab on Devices. Click **Load recent logs** for the newest 100 desktop events from the last seven days. It does not fetch automatically. Managers/workers have no diagnostic panel, and the API independently enforces owner access.
- Workers see only their own recorded hours. The API refuses them the timeline (screenshots, locations, applications) and both delete actions.
- Status, timeline URLs, and hours refresh every 30 seconds while the tab is visible.
- Uploaded intervals without scheduled screenshots appear only in **Activity details**, not as blank image cards. The gallery distinguishes deleted screenshots from unavailable storage and gives an explicit loading/error state for image requests. Records upload about every 30 seconds; screenshots are scheduled every ten running minutes.
- Reporting dates and timeline times use the browser's displayed time zone, passed explicitly to the API.
- The selected date chooses the Monday-to-Sunday reporting week and CSV export range.
- A stale unfinished session can be recovered for the signed-in user after two minutes without a heartbeat. This requires confirmation and is only for a lost computer or app data. Stop and sync the original computer if available, since recovery can prevent its remaining queued records from syncing.
- Screenshot deletion keeps recorded time, while time-block deletion deducts hours.
  Both require explicit confirmation and are available only to managers and owners, for their own blocks.
- Browser authentication uses the API's HttpOnly session cookie.
  No credentials or tokens are saved to browser storage.
- Native labels, table headers, keyboard focus styles, and the screenshot dialog support keyboard and screen-reader navigation.
