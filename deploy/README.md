# Deployment and CI

These files are templates, not a running deployment.
Nothing provisions a server, creates a bucket, publishes a release, or deploys automatically.
Hetzner compute and object storage cost money and require separate user approval.

## Architecture

Run Docker Engine with the Compose v2 plugin on a user-approved Hetzner Linux host.
Caddy serves the React build from `web/dist` and forwards `/api`, `/api/*`, and `/healthz` unchanged to Go on port 8080.
The backend worker confirmed this separate static-server arrangement, so Go does not embed the dashboard.
The Go binary runs embedded SQL migrations automatically at startup under a PostgreSQL advisory lock.
PostgreSQL 17 uses a persistent named volume and has no published port.
The API also has no published port.
The API and Caddy run as UID 10001 with read-only root filesystems, dropped capabilities, and no privilege escalation.
Postgres retains its upstream entrypoint so it can initialize and switch to the postgres user.
Caddy certificate and configuration state use persistent named volumes.
Health checks gate startup, but Compose does not restart a running container merely because it becomes unhealthy.
Monitor unhealthy status and application errors separately.

## Before first deployment

1. Approve the host and storage budget outside this repository.
2. Install Docker and Compose v2 from their official instructions.
3. Point the domain's A record at the host, and only publish an AAAA record if IPv6 is working.
4. Configure the Hetzner firewall to allow TCP 80 and 443 publicly, and TCP 22 only from administrator IP ranges or a VPN.
   Apply equivalent IPv6 rules.
   Keep database, API, and Caddy health port 8081 closed.
   Do not rely on UFW alone for published Docker ports because Docker manages its own forwarding rules.
   Keep outbound DNS, HTTPS, NTP, and the chosen S3 endpoint available.
5. Supply the names listed in `.env.example` using envkit or a mode-0600 file outside the repository.
   Never commit credentials or paste them into command arguments or CI logs.
   Use `envkit set KEY` yourself when a new secret is needed.
6. Set `APP_DOMAIN` to a bare hostname and `ACME_EMAIL` to an operational email address.
   `APP_ORIGIN` is derived as `https://APP_DOMAIN` and `DEV_MODE` is always false.
7. Set `POSTGRES_PASSWORD` to a random value and `DATABASE_URL` to `postgres://worktrack:<URL-encoded-password>@db:5432/worktrack?sslmode=disable`.
   The password must match, and URL-encode reserved characters.
   This URL uses the private Docker network, not a public database listener.
8. Set the three bootstrap variables for initial owner creation.
   Remove them after the initial owner can log in, then recreate the API container.
9. Configure a private Cloudflare R2 screenshot bucket and bucket-scoped credentials using `R2_ENDPOINT`, `R2_REGION` (default `auto`), `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in the example.
   Set each value with `envkit set KEY`.
   Storage uses R2 while the application and database stay on Hetzner.
   Deny public access and configure bucket CORS for the exact HTTPS application origin if direct browser uploads are needed.
   Screenshots contain sensitive employee information.
   Configure access policy, retention, consent, and deletion rules before collecting real data.
   Screenshot storage credentials are not backup credentials.

Run these commands manually from the repository root after configuration:

```sh
envkit run -- docker compose -f deploy/compose.yaml config --quiet
envkit run -- docker compose -f deploy/compose.yaml build --pull
envkit run -- docker compose -f deploy/compose.yaml up -d --wait
envkit run -- docker compose -f deploy/compose.yaml ps
curl --fail https://YOUR_DOMAIN/api/health
```

For an external env file, use `docker compose --env-file /protected/path/worktrack.env -f deploy/compose.yaml config --quiet`, and replace `config --quiet` with the other subcommands shown above.
Do not print expanded `compose config` output because it includes credentials.
Verify HTTPS, browser login, direct agent login, screenshot upload/download, restart persistence, and an off-host backup restore before production use.
The web health check only checks Caddy liveness, so the external `/api/health` check is also required.

## Backups

Install `age` on the host and create an encryption key on a separate trusted recovery machine.
Keep the private identity offline, with a tested recovery copy.
Only the public `age1...` recipient belongs on the server.
The helper streams a PostgreSQL 17 custom-format dump directly through age, uses mode-0700 backup directories and mode-0600 files, and removes partial files on errors.
It does not dump plaintext to disk.
Run manually first:

```sh
BACKUP_RECIPIENT=age1YOUR_PUBLIC_RECIPIENT envkit run -- bash deploy/backup.sh
```

Set `BACKUP_DIR` to an absolute protected path if desired.
After validating the result, configure a daily systemd timer or administrator-owned scheduler yourself.
Copy encrypted dumps off-host to a separate private S3 backup bucket, using bucket-scoped credentials that cannot read or delete screenshot objects.
Deny public access, restrict IAM access to the backup prefix, and configure lifecycle retention, for example 30 daily and 12 monthly copies.
Do not automatically delete the only known-good backups.
This repository creates no bucket or schedule and uploads nothing.
Back up screenshot objects separately, along with protected configuration and Caddy state.
A database dump contains object keys, not screenshot bytes.

Test restoration on an isolated empty database with PostgreSQL 17 tooling:

```sh
set -o pipefail
age --decrypt -i /protected/recovery-identity.txt /protected/backup.dump.age \
  | pg_restore --exit-on-error --no-owner --no-acl --dbname="$RESTORE_DATABASE_URL"
```

Do not restore over production or use `--clean` without an approved recovery plan.
Verify row counts, owner login, reports, and access to restored screenshot objects.
Record backup age, restore duration, and the acceptable recovery window.
Never put the age private key in GitHub Actions or on the production host.

## Updates and rollback

Record the source commit and resolved image digests for each approved deployment.
Image tags here select maintained major lines, not immutable artifacts.
Review and pin tested digests for a production release and schedule dependency updates.
Take an encrypted backup before updates, build from the approved commit, then use the manual commands above.
Keep the previous source/images, but do not assume application rollback can reverse a database migration.
Test migration compatibility first and use a separately approved restore if needed.
Never run `docker compose down -v` on a live deployment because that deletes named volumes.
Changing `POSTGRES_PASSWORD` alone does not rotate a password in an existing database volume.
Coordinate database role rotation and the API URL in a maintenance window.

## CI and Windows installers

The CI workflow builds and tests the dashboard, runs Go formatting/vet/race tests against a disposable Postgres 17 service, exercises the live HTTP API with `scripts/integration.mjs`, validates Compose/Caddy, builds both Docker targets, and smoke-tests hardened Caddy startup, HTTPS, SPA fallback, UID, health and redirects.
It also runs `scripts/container-acceptance.sh` through the production React/Caddy, Go and Postgres images over HTTPS, using only its disposable fixture CA for the test Node process.
CI-only database passwords are disposable test values, not production secrets.
The Windows workflow runs Cargo check/tests with the committed lockfile and builds an NSIS installer on a Windows runner.
It runs for agent or Windows workflow/override changes, so unrelated documentation/backend commits do not cancel an in-progress Windows build.
Artifacts expire after seven days and are not GitHub releases.
A separate `Windows installer smoke` workflow runs only after a successful same-repository `main` Windows build.
It downloads that exact run's artifact with an ephemeral Actions read token, silently installs it per-user under the disposable runner's temporary directory, and checks the installed process survives five seconds before stopping only that process.
It uses no configured repository secrets and grants no write permissions.
This is a packaging/startup smoke test, not a test of tracking-off UI, desktop capture, lock, suspend, or an actual worker machine.
No workflow has deployment credentials, SSH access, write permissions, release publishing, or automatic deployment steps.
GitHub-hosted runner/artifact quotas and private-repository billing are external account constraints.
Review those settings before enabling workflows on a paid account.

Windows installers are unsigned initially and may display SmartScreen or publisher warnings.
Windows code signing is separate from Tauri updater signing.
The workflow explicitly disables updater artifact creation and must not enable an updater endpoint or updater plugin at runtime.
Tauri updater signatures can use a locally generated free key pair, but enabling updates requires embedding the correct public key, protecting the private signing key, hosting signed manifests/artifacts over HTTPS, and testing both valid updates and signature rejection.
No updater is enabled by these templates.
Authenticode signing, reputation, and any certificate purchase need separate approval.

## External validation limits

On October 21, 2026, both Docker targets built locally and `bash deploy/test-web.sh worktrack-web:validation` passed against the real Caddy runtime image.
Compose validation, workflow actionlint, YAML parsing, and shell syntax checks passed.
Go race tests with `WT_TEST_DATABASE_URL` and the real HTTP acceptance script also passed against a separate disposable Postgres 17 container.
The smoke test runs an isolated disposable local container with no published ports and no external network.
Encrypted backup creation/restoration was not executed locally because age and a recovery identity are not configured.
Windows builds must be verified on the Windows CI runner.

Local YAML/shell/Compose checks do not prove a deployment works on Hetzner.
Real DNS, ACME certificate issuance, firewall behavior, private object storage policies, Windows NSIS execution, restore drills, and complete agent behavior need the appropriate external host or Windows runner.
Consult the official Docker Compose services/startup-order documentation, Caddy common patterns documentation, and Tauri v2 GitHub pipeline/Windows installer documentation when changing these templates.
