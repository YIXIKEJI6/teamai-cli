# Central usage service

This is a standalone, single-instance Node 24 service for reviewed statistics-only
snapshots. It does not scan HOME, install Hooks, read transcripts, replace Git
resource distribution, or implement the upstream local-agent report/sync/ack backend.
See the [Chinese operational and protocol guide](central-service.zh-CN.md) for the
same contract in detail.

## Build and real acceptance

```sh
docker build --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" --iidfile /tmp/teamai-image-id .
export TEAMAI_CENTRAL_IMAGE="$(cat /tmp/teamai-image-id)"
node scripts/central-e2e.mjs docker
```

The official Node 24.21.0 bookworm-slim image index digest is pinned in Dockerfile.
The runtime installs Debian's `libpcre2-8-0=10.42-1+deb12u1` security fix and removes
the inherited npm/Yarn and Corepack directories, dependencies and entrypoints from the final
filesystem. The build retains npm for locked installation and runs type checking
and central/upstream regressions. Only the central application bundle, migration
and license are copied to runtime; Debian/Node files remain and need image-level
vulnerability review. Runtime uses UID 1000 and an independent data volume.
The acceptance script uses fresh synthetic members, projects, credentials and a
temporary volume. It tests actual HTTP, authentication, revocation, replay, ordering,
privacy, then recreates the container and verifies unchanged data. It records actual
Node/OpenSSL/Undici/zlib versions, PCRE2 package/file hashes and npm/Yarn absence.
The image HEALTHCHECK must execute successfully; read-only root, UID, capabilities,
no-new-privileges, loopback binding, read-only auth mount, 256 MiB/1 CPU and tmpfs
constraints are checked. A fixture-only soft delete keeps the physical row and hides
it from HTTP summaries. SQLite's backup API runs while the service is live; an
independent restored volume must preserve schema, dataset, rows, deletion state,
authentication, replay and summaries. Migration runs twice on both volumes.
The driver only removes its own synthetic resources. The existing CI job retains
the image archive, source and raw acceptance evidence; read config/layer identities
from that archive. Its workflow is unchanged;
it does not publish images, npm packages or production deployments.

For a separate local process check (not a substitute for Docker), run `npm ci
--ignore-scripts`, `npm run typecheck`, `npm run test:central`, `npm run build`, then
`node scripts/central-e2e.mjs local`. Existing CLI output and Node 20 build target
remain; only the central runtime requires Node 24 with native SQLite.

The release version and installed package fix are not a claim that all remaining
OS/embedded libraries are vulnerability-free. Scan the exact built image, retain
the scanner/database identity, and review remaining applicability before release.
An image config ID is distinct from a registry manifest digest. CI does not publish
to a registry; do not invent a deployment digest from a local image ID.

## Operator configuration

Review an identities JSON outside the repository using
`docker/identities.synthetic.json` as a synthetic example. Set `dataset` to
`production` for production, use a separate volume and set an explicit future UTC
expiry. Member/installation/project/admin aliases allow only letters, numbers,
underscores and hyphens, with at most 64 characters. No paths or hostnames.

```sh
node scripts/central-credentials.mjs /secure/reviewed-identities.json /secure/NEW-teamai-credentials
export TEAMAI_CENTRAL_AUTH_DIR=/secure/NEW-teamai-credentials/server
export TEAMAI_CENTRAL_ORIGIN=https://usage.example.com
export TEAMAI_CENTRAL_IMAGE=sha256:REPLACE_WITH_VERIFIED_IMAGE_ID
docker compose -p teamai-central run --rm central migrate
docker compose -p teamai-central up -d central
```

Only mount `server/`, whose auth.json contains SHA-256 credential hashes and approved
bindings. Random 256-bit client/admin credentials are separate 0600 files and are
never printed; distribute them through the existing approved secure channel. Arrange
server directory/file ownership for UID 1000 (0700 directory, 0600 file) through the
authorized operator. Never mount HOME, SSH, the Docker socket or complete TeamAI
configuration. Configuration is reread per request; atomic replacement of auth.json
revokes/rotates credentials immediately, including existing browser sessions.

Migration is an explicit versioned structure operation, never automatic startup
repair or data backfill. Data volumes are bound to synthetic or production mode.
Compose maps only host loopback and hardens the container with a read-only root,
removed capabilities and no-new-privileges. Keep its project name stable on recreate;
never use `down -v` as a production restart. Configure a reviewed HTTPS reverse proxy;
HTTP public origin is allowed only for loopback validation. Direct Node defaults to
127.0.0.1:3722; upstream local dashboard still uses 127.0.0.1:3721.

## Protocol and measurement

`GET /healthz` is public availability only. `/login` issues an HttpOnly,
SameSite=Strict, eight-hour browser session (Secure over HTTPS); `/logout` requires
same origin. `GET /`, `/api/usage/options` and `/api/usage/summary` require an admin
credential or session. Installations cannot read summaries, and admins cannot report.

`POST /api/usage/report` requires a bound installation Bearer. Exact required fields:
schemaVersion=1, UUID eventId/sessionId, memberId/installationId/project, millisecond
UTC firstStopAt/observedAt, monotonic positive integer sequence, prompts and the four
token buckets input/output/cacheRead/cacheCreation, producerVersion. Counters are
nonnegative integers up to 10^12 or null. Body limit is 8192 bytes. Unknown fields,
content/path fields, wrong identity/project, negative counters and times over five
minutes in the future are rejected without echoing input.

Events are idempotent per installation: identical replay is duplicate; changed
content with the same event ID is 409. Session identity includes member, installation,
project and anonymous session UUID. Older revisions are stale, equal revision with
a different event or decreasing counters/date changes conflict. New revisions replace
the cumulative snapshot transactionally. Producers must aggregate legacy Codex
rollouts into one logical session snapshot before sending; modern Codex snapshots
are already session-scoped. No real producer Hook is shipped/enabled in this stage.

Summary filters are member/project/from/to, inclusive UTC dates, maximum 366 days.
For example, `from=2025-01-01&to=2026-01-01` includes 366 dates and is valid;
extending `to` to `2026-01-02` includes 367 dates and returns HTTP 400.
Whole sessions are attributed to firstStopAt's UTC date, even when resumed later.
This is not per-request usage during the selected interval. Input excludes cached
buckets according to native TeamAI parsing. Unknown is null, never an invented zero;
API returns known subtotals and unknown counts. latestReport is the latest accepted
new snapshot receipt within the filter; retries/stale reports do not refresh it.
No billing, price estimate, SSO integration or account quota is claimed.

There is no public delete/restore operation or automatic retention cleanup. Default
queries filter del_status=0; authorized data governance is separate. Logs only contain
fixed route/status information, never bodies, query strings or credentials.

## Deployment and recovery boundary

Audit existing services, DNS, TLS, storage and authentication first. Add only the
authorized proxy route, cap request bodies/timeouts and exclude credentials/bodies
from logs. Verify real HTTPS, anonymous/invalid/revoked access, isolated synthetic
statistics and persistence before declaring service readiness.

Use SQLite's consistent backup API, or stop this service and copy its complete volume;
copying only the main database during writes can lose WAL data. Rehearse restores
into an independent volume before switching. Use an accepted immutable image for
rollback. On first deployment there is no previous image: rollback stops the new
service, withdraws only its dedicated proxy configuration and retains its data.
Never invent a previous digest. Source/CI/local acceptance, independent review,
production deployment and real member collection are distinct evidence levels.
