[Русский](README.md) · **English**

# Carbone Reports

Report generation based on Carbone, with template editing in the browser (OnlyOffice) and a GravityUI interface.

Website with interface screenshots: <https://samrozhkov.github.io/carbone-report/>.

The stack: web (nginx), API, backup agent, OnlyOffice Document Server, PostgreSQL, Redis, S3 (SeaweedFS). There is no separate Carbone container: the API itself builds reports with the built-in Carbone Community Edition 3.8.2 (`packages/carbone`, `worker_threads` workers). The build produces a document in the template format; PDF and conversion to ODT/ODS are done by OnlyOffice, so **OnlyOffice is required to build reports**: the API builds a PDF first, and without Document Server a report cannot be generated. Details about the license are in the section [“License”](#license), about the move from 1.x in [“Upgrading from 1.x”](#upgrading-from-1x).

[![CI](https://github.com/SamRozhkov/carbone-report/actions/workflows/ci.yml/badge.svg)](https://github.com/SamRozhkov/carbone-report/actions/workflows/ci.yml)

Changes by release are in [`CHANGELOG.md`](CHANGELOG.md) (in Russian); on a `vX.Y.Z` tag CI publishes its section as a GitHub release.

Specification: `docs/superpowers/specs/2026-10-02-carbone-reports-design.md` (in Russian).

## API development

Requirements: Node 22 (`nvm use`), pnpm 10 (`corepack enable`), a running Docker (for integration tests).

```bash
pnpm install
pnpm test          # unit tests
pnpm test:int      # integration (PostgreSQL, Redis and SeaweedFS in testcontainers; then selected files on S3 — test:int:s3)
pnpm typecheck && pnpm lint
```

Running the API locally:

```bash
docker run -d --name cr-pg -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=app -p 5432:5432 postgres:17-alpine
cp .env.example .env   # fill in the secrets
cd apps/api && node --env-file=../../.env --import tsx src/server.ts
```

## Running in Docker

You need Docker with Compose v2.24+. The first start downloads the OnlyOffice image (several GB).

```bash
cp .env.example .env      # fill in the required variables
```

**Development** (API with hot reload, the interface at http://localhost:8080, the API directly on :3000, PostgreSQL on :55433; ports 8080, 3000 and 55433 listen on 127.0.0.1 only):

```bash
pnpm stack:dev
```

**Production** (HTTPS in nginx; put the certificate and key into `certs/fullchain.pem` and `certs/privkey.pem`;
for a local check use `./scripts/dev-cert.sh`):

```bash
pnpm stack:prod
```

The HTTP to HTTPS redirect goes to the standard port 443; if `WEB_HTTPS_PORT` is different, open `https://host:<port>` directly.

**Checking a running stack** (run `pnpm install` on the host first):

```bash
pnpm stack:smoke                                        # development, http://localhost:8080
BASE_URL=https://localhost pnpm stack:smoke --insecure  # production with a self-signed certificate
```

If `WEB_HTTPS_PORT` is not 443, specify the port in `BASE_URL`, for example `BASE_URL=https://localhost:8443`.

To stop: `pnpm stack:down` (data is kept in volumes; `docker compose down -v` will delete it).

In production only nginx is exposed externally. The `/internal/*` routes are closed: only OnlyOffice calls them, inside the network.
The development and production modes on one host use one compose project, and therefore share the `pgdata` and `s3_data` volumes. The development image is called `carbone-reports-api:dev` and does not overwrite the production image.

### Data

State is kept in the `pgdata` (PostgreSQL) and `s3_data` (SeaweedFS: template and report files in the `S3_BUCKET` bucket, `carbone-reports` by default) volumes. The `oo_*` volumes are restored on their own. Backups are described in the section [“Backups”](#backups).

`POSTGRES_PASSWORD` is applied only when the `pgdata` volume is first created; later the password is changed inside PostgreSQL (`ALTER USER`), not in `.env`.

### Files in S3 storage

The API keeps files in S3-compatible storage: in compose this is the `s3` service — [SeaweedFS](https://github.com/seaweedfs/seaweedfs), the official `chrislusf/seaweedfs` image with a pinned version, all components in one container (`weed mini`), data in the `s3_data` volume. The service runs only in the internal `s3` network together with `api` and `backup`: ports and web interfaces are not published externally, only S3 is enabled (port 8333). This is why several API instances can work without a shared volume.

Variables in `.env`:

- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` — required (compose will not start without them), for example `openssl rand -hex 16` and `openssl rand -hex 32`; Latin letters, digits and `. _ ~ + / = -` are allowed. At every start the `s3` service creates the only S3 account from them (`docker/s3/entrypoint.sh`, a file inside the container); `api` and `backup` use the same one. To change the keys, change them in `.env` and run `docker compose up -d s3 api backup` (otherwise the backup agent keeps working with the old keys). The data does not change;
- `S3_BUCKET` — the bucket name, `carbone-reports` by default. The API creates the bucket at the first start (`S3_CREATE_BUCKET=true` in compose); SeaweedFS itself does not create buckets on write. The bucket must belong to one installation: a restore runs `rclone sync` and deletes from the bucket all objects that are not in the archive (including foreign ones), and the lock that coordinates a backup with file deletion works only in the database of this installation and will not stop other installations that use the same bucket.

The `s3` service mounts `docker/s3/entrypoint.sh` from the project directory, so `docker compose` is run from the repository root.

**Moving an installation from the `storage` volume** (an upgrade from a version before Plan 14) goes through backup and restore; the archive format is the same:

1. Before the upgrade, make a manual backup with the old version: `docker compose --profile backup run --rm backup now`.
2. Add `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` to `.env`, update the code and start the stack: the API will create an empty bucket.
3. Restore the copy: `scripts/restore.sh backups/<directory>` — the database is replaced with the same one, and the files from the archive end up in the bucket. A restore replaces the whole database and clears Redis: changes made after the backup of step 1 (new templates, reports, users) will be lost, so nobody should work in the system between steps 1 and 3.
4. Check that templates open and reports download. The `storage` volume is no longer used; you can delete it manually: `docker volume rm carbone-reports_storage`.

### Redis

The `redis` service (`redis:7-alpine`, no persistence to disk, `maxmemory 128mb`) keeps temporary state shared by all API instances (the Carbone template cache is no longer in it: the build runs inside the API process):

- sign-in attempt counters (`cr:rl:*` — per login, `cr:rl-ip:*` — per IP; see [Sign-in attempt limits](#sign-in-attempt-limits));
- the `cr:maintenance` maintenance flag for the time of a restore from a backup (it is set and cleared by the backup agent, see [Backups in the admin UI](#backups-in-the-admin-ui)).

There is no need to back up Redis: after a restart it is empty, and everything recovers by itself. The address is set by `REDIS_URL` (`redis://redis:6379` by default); in compose it is built with the password: `redis://:${REDIS_PASSWORD}@redis:6379`.

Redis requires a password (`--requirepass`). The `REDIS_PASSWORD` variable in `.env` is required (hex only: `openssl rand -hex 32`); without it `docker compose` does not start. The password is checked when the `redis` container starts. If it contains anything other than `0-9a-f`/`A-F`, the container exits with the message “REDIS_PASSWORD: только шестнадцатеричные символы (openssl rand -hex 32)” (in Russian: “REDIS_PASSWORD: hexadecimal characters only (openssl rand -hex 32)”; visible in `docker compose logs redis`), and `api` does not start. The password is substituted inside the container and is not visible in the command (`docker inspect`), but it is in its environment. `redis-cli` inside the container takes the password from `REDISCLI_AUTH`, so the healthcheck and `docker compose exec -T redis redis-cli …` work without `-a`. To change the password, change `REDIS_PASSWORD` in `.env` and run `docker compose up -d redis api backup` (the backup agent also connects to Redis with the password; Redis data is disposable).

Redis is connected only to the internal `cache` network (`internal: true`), shared with `api` and the backup agent (the `backup` service). Other services (nginx, OnlyOffice, the demo DB) do not see it, and this network has no way out.

In compose, `api` waits at startup until Redis becomes healthy (`depends_on`). Operation without Redis concerns the time after startup. If Redis becomes unavailable, the API keeps working: sign-in attempt limiting is counted in the memory of each API instance until Redis returns. Connection errors appear in the API log (at most once every 30 s).

### Sign-in attempt limits

Sign-in (`POST /api/auth/login`) is limited by two independent limits; the one exhausted first applies, and the response is `429 TOO_MANY_ATTEMPTS`:

- **per login** — 10 attempts per minute per login (case-insensitive), “too many sign-in attempts, try again in a minute”;
- **per IP** — 30 attempts per minute from one address for any logins, “too many sign-in attempts from this address, try again in a minute”.

The counters are in Redis and shared by all API instances. If Redis is unavailable or returns an error, the limits keep working, but are counted in the memory of each API instance separately (with N instances — up to N × the limit of attempts). After an error the API does not contact Redis for 5 s, then tries again; the log says “Redis недоступен — лимиты запросов считаются в памяти экземпляра” (in Russian: “Redis is unavailable — request limits are counted in the instance memory”; at most once per 5 s).

The API takes the client IP from `X-Forwarded-For`, which nginx appends: by default exactly one proxy is trusted (`TRUSTED_PROXY_HOPS=1`, 1–5, the equivalent of `trustProxy: 1`; in the Helm chart 2: Ingress and nginx), so addresses that a client puts into the header are ignored. In Fastify 5 a number in `trustProxy` trusts no hops at all (fail-closed): all clients would get the nginx address and share one common sign-in limit of 30 per minute for the whole site. This is why trust is set by the `trustProxyHops()` function. If there is one more proxy or load balancer in front of nginx, all clients will get its address and share one limit — increase `TRUSTED_PROXY_HOPS` (in `.env` or the chart's `config.trustedProxyHops`), not `trustProxy`. Users behind a common NAT or corporate proxy also share the per-IP limit. If the original client address is lost, all clients share one per-IP limit: for example, when ports are published in Docker Desktop/OrbStack (the host gateway address) or with IPv6 through docker-proxy; a single attacker can then exhaust sign-in attempts for everyone for a minute. If this matters, put nginx on the host network or use a proxy that preserves the original address. The residual risk: code inside a container that can reach `api:3000` directly (in the default compose network or through 127.0.0.1:3000 published in dev) can forge `X-Forwarded-For` and bypass only the per-IP limit; the per-login limit is not affected.

### Running from prebuilt images

CI publishes images after green checks:

- `ghcr.io/samrozhkov/carbone-report-api`, `ghcr.io/samrozhkov/carbone-report-web`;
- `ghcr.io/samrozhkov/carbone-report-backup` (the `backup` service: a Node backup agent on top of `postgres:17-alpine` + `rclone`);
- tags: `latest` and `main` — the latest `main` build, `sha-<commit>`, `X.Y.Z` and `X.Y` — releases from `vX.Y.Z` tags.

```bash
# in .env
API_IMAGE=ghcr.io/samrozhkov/carbone-report-api:1.0.0
WEB_IMAGE=ghcr.io/samrozhkov/carbone-report-web:1.0.0
BACKUP_IMAGE=ghcr.io/samrozhkov/carbone-report-backup:1.0.0

docker compose pull api web s3 backup
docker compose up -d --no-build
```

With `API_IMAGE`/`WEB_IMAGE` set, do not use `pnpm stack:*`: they rebuild the local sources and tag them with the release name. Use `docker compose pull` and `up -d --no-build`.

New GHCR packages are private: make them public (Package settings → Change visibility) or sign in on the server: `echo <token> | docker login ghcr.io -u <user> --password-stdin` (a token with the `read:packages` right).

### Updating and rollout

Add `REDIS_PASSWORD` to `.env` before updating (`openssl rand -hex 32`, see [Redis](#redis)): without it `docker compose` will not start.

Add `BACKUP_AGENT_TOKEN` to `.env` before updating to the version with backup management from the admin UI (`openssl rand -hex 32`, at least 32 characters): without it `docker compose` will not start — neither `up`, nor `run`, nor `scripts/restore.sh`. The `backup` service now starts together with the stack (`docker compose up -d`); the `backup` profile is no longer needed.

Before updating, make a [manual backup](#backups) (the “Create backup” button in the admin UI or `docker compose run --rm backup now`): migrations run when the API starts, and migration 0002 drops the `ssl` column, so a rollback is possible only by restoring from a copy. After this update every user has to sign in again once.

In production the session cookie is marked `Secure` (with `COOKIE_SECURE=true` it is called `__Host-session`), so the interface works only over HTTPS.

### Backups

**What a backup includes:** the `app` database (`pg_dump -Fc`) and the template and report files — the bucket in the `s3` service. The `backup` service copies the bucket with `rclone` (the `SeaweedFS` provider) into a temporary directory and packs it into `storage.tar.gz`, in the same format that the `storage` volume used to give; the temporary directory is then deleted. The dump and the bucket copy are taken under one lock, so they are consistent: while a backup is running, the API postpones file deletion.

The `backup` service is the backup agent (`apps/backup-agent`, Node). It starts together with the stack, runs backups on a schedule as well as backups and restores from the admin UI ([Backups in the admin UI](#backups-in-the-admin-ui)), and calls the same `docker/backup/*.sh` scripts. The image is built from `docker/backup/Dockerfile` with the repository root as the context: `postgres:17-alpine`, `rclone`, Node, the agent, the scripts and the `apps/api/drizzle` migrations (the agent uses them to check the schema version of a backup). Changing the scripts requires a rebuild: `docker compose build backup`. S3 settings are passed to `rclone` by environment variables (`RCLONE_CONFIG_S3_*`); there is no configuration file with the keys.

**What is not included:**

- `.env` with `ENCRYPTION_KEY`: without it the data source passwords cannot be decrypted from a backup;
- `certs/`;
- the OnlyOffice caches (the `oo_*` volumes are restored on their own).

Keep `.env` and `certs/` separately and securely.

Each backup is a directory `backups/<YYYY-MM-DDTHH-MM-SSZ>/` (or in your `BACKUP_DIR`; time in UTC) with the files `db.dump`, `storage.tar.gz` and `manifest.txt` (sizes and sha256). An unfinished backup stays with the `.partial` suffix and does not take part in rotation. Backups made before a restore are called `pre-restore-<time>`: `BACKUP_KEEP` does not apply to them (and such a backup does not rotate ordinary copies), the 3 latest are kept; the backup being restored from at the moment is not deleted by rotation. In `backups/.op/` the agent keeps its state (`state.json`), the `.op.lock` lock and the logs of the 20 latest operations. Rotation (deleting copies beyond `BACKUP_KEEP`) runs only after a successful ordinary backup, so a series of failed runs does not delete old good copies. The `.partial` directories are not deleted by themselves: find out the cause of the failure from the log and delete them manually, for example `rm -rf backups/*.partial` (when no backup is running).

**On a schedule** a backup is started by the agent itself — the `backup` service starts together with the stack (`docker compose up -d`). If another operation is running at the moment of the start (a backup or restore from the admin UI, a manual `now`), the scheduled run is skipped with a log entry.

Variables in `.env`:

- `BACKUP_AGENT_TOKEN` — the required token between `api` and the agent (at least 32 characters, `openssl rand -hex 32`); without it `docker compose` does not start;
- `BACKUP_CRON` — the schedule in cron format, `0 3 * * *` by default. The time is taken in the `TZ` time zone (`Europe/Moscow` by default), not in UTC. The string must consist of exactly 5 fields; otherwise the container exits with code 2 and the message “BACKUP_CRON: ожидается 5 полей cron” in the log (in Russian: “BACKUP_CRON: 5 cron fields expected”; and because of `restart: unless-stopped` it restarts with the same error until the string is fixed). An invalid field value or time zone gives “BACKUP_CRON: неверное выражение … или часовой пояс TZ=…” (“BACKUP_CRON: invalid expression … or time zone TZ=…”);
- `BACKUP_KEEP` — how many latest copies to keep, 14 by default;
- `BACKUP_TIMEOUT` — the time limit of each step (`pg_dump` and file archiving): an integer number of seconds ≥ 1 without suffixes (`3600`, not `1h` or `60m`), 3600 by default. An invalid value is checked when the container starts: it exits with code 2 and the message “BACKUP_TIMEOUT должен быть целым числом секунд ≥1” (“BACKUP_TIMEOUT must be an integer number of seconds ≥1”). A step that does not finish in time gets TERM (and KILL after 60 s) and is interrupted, the copy stays `.partial`, and the lock is released — a hung backup does not delay file deletion in the API forever;
- `BACKUP_DIR` — the directory on the host, `./backups` by default.

Log: `docker compose logs backup`.

**Manually**, for example before a rollout:

```bash
docker compose run --rm backup now
```

A manual backup and the agent do not work at the same time: if the agent is busy, the command exits with code 75 and the message “идёт другая операция с бэкапами (агент) — повторите позже” (“another backup operation (agent) is running — try again later”). While the agent is in the “restore required” state (see below), a manual backup would save a partially replaced database — finish the restore first.

**Emergency restore** (without the web interface; normally a restore is started from the admin UI):

```bash
scripts/restore.sh backups/<directory>
```

The script:

1. checks the sha256 of the files against `manifest.txt`;
2. asks you to type `restore` to confirm;
3. stops the backup agent (the `backup` service): it will not start a backup in the middle of replacing files and will not bring back the maintenance flag;
4. stops `api` and `web` (the interface is unavailable until the restore is over);
5. replaces the `app` database with the dump in one transaction: it drops the `public` and `drizzle` schemas entirely and creates them again from the dump (on an error the database stays as it was);
6. replaces the storage files with the archive (the archive is verified before any changes): it unpacks it into a temporary directory and runs `rclone sync` into the bucket — objects that are not in the archive are deleted. The archive is unpacked into `/tmp` of a one-off `backup` container, so Docker needs free space of about the size of the unpacked archive (the data in the bucket, not the compressed `storage.tar.gz`). `STORAGE_BACKEND=local scripts/restore.sh …` restores the `storage` volume — only for installations where the API itself works in local mode (`STORAGE_BACKEND=local` for the `api` service); the stack from this repository works with S3, and the script in local mode will refuse to work for it;
7. marks an unfinished restore from the admin UI in `backups/.op/state.json` as `failed (resolved externally)`: after the start the agent no longer turns on maintenance mode;
8. clears Redis (`FLUSHALL`; if Redis is stopped, it starts it first): the sign-in attempt counters and stale state are reset. If clearing failed, the script warns and continues — then run `docker compose exec -T redis redis-cli FLUSHALL` manually;
9. starts `api` and `web`, then `backup` again.

If a step after stopping `api` and `web` failed, the script reports whether the database had time to be replaced, starts `backup` again and leaves `api` and `web` stopped: fix the cause and run the script again, or bring the stack back with `docker compose up -d --wait api web` (if the database is already replaced and Redis is not cleared, the script will remind you to clear it first).

You can also restore into a clean stack: first start it with the same `.env`, then run the script. You can also restore into a newer version of the application: the database is fully replaced with the state from the backup (tables and migrations that are not in the dump are dropped), and the API will apply the missing migrations again at startup.

**A copy to another server** is left to the administrator, for example by cron on the host:

```bash
rsync -a --exclude '*.partial' backups/ backup-host:/srv/carbone-reports-backups/
```

Here `backups/` is the default directory (or your `BACKUP_DIR`). Rotation of copies on the remote side is configured by the administrator.

### Backups in the admin UI

The “Backups” item in the administrator menu appears when `api` has `BACKUP_AGENT_URL` and `BACKUP_AGENT_TOKEN` set (in compose — always). The agent listens on port 8080 only in the internal `backup` network between `api` and `backup`: inside the stack it is reachable at `http://backup-agent:8080` (the `backup-agent` alias exists only in this network), the port is not published externally, and every request to it except `/health` requires the token. `BACKUP_AGENT_TOKEN` is required in `.env` for any `docker compose` command, including `scripts/restore.sh`; when updating, add `BACKUP_AGENT_TOKEN` to `.env`: `openssl rand -hex 32`.

- **List** — date, directory name, type (ordinary or “before restore”), size of the database and files, last migration, status. Unfinished (`.partial`) ones cannot be restored.
- **“Create backup”** — the same as `docker compose run --rm backup now`. Above the table is the last operation: who started it, the stage, the status and the log.
- **“Restore”** — after typing the backup name:
  1. check: checksums and schema version. A backup made by a newer version of the application is not restored;
  2. a backup of the current state (`pre-restore-<time>`);
  3. maintenance mode: all users see the “Restoring from backup…” screen, the API responds with `503`;
  4. the database is replaced in one transaction, with migrations up to the current schema;
  5. restoring the files in the bucket (`rclone sync`);
  6. clearing Redis.

  When it is over, the page reloads. The user and the version of their sessions are taken from the restored database, so you may have to sign in again, the administrator included.

- **If a restore failed after the database was replaced**, maintenance mode stays. The agent prints a one-time code to the log: `docker compose logs backup | grep 'КОД ВОССТАНОВЛЕНИЯ'` (“КОД ВОССТАНОВЛЕНИЯ” is “RECOVERY CODE”; the agent's messages are in Russian). On the maintenance screen enter the code from the log (letter case, spaces and hyphens do not matter) and choose:
  - “Retry restore from …”;
  - “Return to the state before the restore (pre-restore-…)”.

  If there is no backup from before the restore, the second option is unavailable: `POST /api/maintenance/retry` responds with `400` and the code `BAD_TARGET` “нет бэкапа до восстановления” (“no backup from before the restore”), and the code attempt is not used up. After 5 wrong attempts the code is replaced with a new one; a new code is also printed at every new failure and when the agent restarts. Entering the code is limited to 10 attempts per 15 minutes from one address.

- **The emergency path without the web interface** — `scripts/restore.sh` (see above). It stops the agent, marks the unfinished restore as done manually and clears Redis together with the maintenance flag.

## Kubernetes (Helm)

The chart is `charts/carbone-reports`: web (nginx), API, backup agent, OnlyOffice; Postgres, Redis and S3 are external or bundled (by flags). Kubernetes 1.27+ and Helm 3.8+ are required (tested on Helm 4.3).

The chart has no `carbone` component; reports are built by the API. The `api` resources are increased for this (by default `requests: 500m / 512Mi`, `limits.memory: 2Gi`), the number of threads is `config.renderWorkers`. Each API replica serves the report file to Document Server at the address of its own pod: the chart builds `API_SELF_URL` from the pod IP (`http://$(POD_IP):3000`; IPv4, see [“Configuration”](#configuration)).

### Installation

From the repository directory:

```bash
helm install cr charts/carbone-reports -n reports --create-namespace -f my-values.yaml
```

After the first release the chart can be taken from the OCI registry (CI publishes it on `vX.Y.Z` tags; only such a chart has an `appVersion` equal to the tag version and matching the image tag):

```bash
helm install cr oci://ghcr.io/samrozhkov/charts/carbone-reports --version X.Y.Z -n reports -f my-values.yaml
```

When installing from the directory, always set `image.tag`: in the repository `appVersion` is `0.1.0`, and there are no images with such a tag. `main`, `sha-<7 characters of the commit>` or `X.Y.Z` of a released version will do. GHCR packages are private: make them public or create a Secret of the `docker-registry` type and specify it in `imagePullSecrets: [{ name: ghcr-pull }]`.

### Trial installation

Bundled Postgres, Redis and SeaweedFS: take `charts/carbone-reports/ci/bundled-values.yaml`, replace `ingress.host` and all the values in `secrets`. Passwords and tokens — `openssl rand -hex 32`, `encryptionKey` — `openssl rand -base64 32`. Without TLS on the Ingress add `config.cookieSecure: false`.

### Production

Minimal values for external Postgres, Redis and S3 (like `ci/external-values.yaml`; the secret values below are placeholders):

```yaml
ingress:
  host: reports.example.com
  className: nginx
  tls:
    secretName: reports-tls
existingSecret: carbone-reports-secrets # or secrets.* for a chart-managed Secret
externalDatabase:
  host: pg.example.com
  sslMode: verify-full
  caSecret:
    name: pg-ca
externalRedis:
  url: rediss://redis.example.com:6380
externalS3:
  endpoint: https://storage.example.com
  bucket: reports
  forcePathStyle: true
  rcloneProvider: Other
```

`existingSecret` is a ready Secret with the following keys (without `existingSecret` the chart creates it from `secrets.*`):

| Key                     | Required        | Requirements                                                                                                   |
| ----------------------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| `APP_SECRET`            | yes             | at least 32 characters                                                                                         |
| `ENCRYPTION_KEY`        | yes             | 32 bytes in base64 (`openssl rand -base64 32`)                                                                 |
| `ONLYOFFICE_JWT_SECRET` | yes             | at least 32 characters                                                                                         |
| `ADMIN_LOGIN`           | yes             | the login of the first administrator                                                                           |
| `ADMIN_PASSWORD`        | yes             | at least 8 characters                                                                                          |
| `POSTGRES_PASSWORD`     | yes             | any characters                                                                                                 |
| `REDIS_PASSWORD`        | yes             | any characters; for the bundled Redis, hex only (`openssl rand -hex 32`)                                       |
| `BACKUP_AGENT_TOKEN`    | yes             | at least 32 characters                                                                                         |
| `S3_ACCESS_KEY_ID`      | bundled S3: yes | both S3 keys or neither (external S3 without keys — IRSA); for the bundled S3 only `A-Z a-z 0-9 . _ ~ + / = -` |
| `S3_SECRET_ACCESS_KEY`  | bundled S3: yes | same                                                                                                           |
| `LDAP_BIND_PASSWORD`    | no              | the LDAP bind password (`config.ldap.bindDn`)                                                                  |

The Postgres and Redis passwords may contain any characters: they are inserted into URLs with encoding.

### Ingress

Set `ingress.host`, `ingress.className` and `ingress.tls.secretName`. For ingress-nginx the annotations are required — without them uploading to OnlyOffice does not work:

```yaml
ingress:
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: 100m
    nginx.ingress.kubernetes.io/proxy-read-timeout: '300'
    nginx.ingress.kubernetes.io/proxy-send-timeout: '300'
```

`config.trustedProxyHops: 2` (the chart default) is the Ingress and the nginx of the web image. If there is one more load balancer in front of the Ingress that adds `X-Forwarded-For`, set 3: otherwise all clients will share one sign-in attempt limit. Without an Ingress (web through LoadBalancer/NodePort) set `config.trustedProxyHops: 1`: otherwise a client will forge `X-Forwarded-For` and bypass the per-IP sign-in limit.

With `onlyoffice.enabled: false`, give `onlyoffice.internalUrl` as a full name: `http://<svc>.<ns>.svc.cluster.local` or a public FQDN. A short name (`http://docserver`, `http://svc.ns`) gives 502 on `/onlyoffice/`: the nginx resolver does not use search domains, although the API (Node) resolves such a name.

An external Document Server fetches the built report for conversion from a specific API replica — by `API_SELF_URL`, that is, directly by the pod IP (`http://$(POD_IP):3000`), not through a Service. Access to the `api` Service is not enough: Document Server must reach the IPs of the API pods on port 3000 (routing and, with `networkPolicy.enabled: true`, a policy that allows this traffic). Otherwise PDF and conversion to another format fail with a conversion error.

### External Postgres with TLS

`externalDatabase.sslMode` is `disable`, `require`, `verify-ca` or `verify-full`, as in libpq. For `verify-ca` and `verify-full` you need `externalDatabase.caSecret` (a Secret with the root certificate in PEM, the key is `externalDatabase.caSecret.key`, `ca.crt` by default); without it the chart does not install.

### S3 without keys (IRSA)

Do not set the S3 keys and specify the role on the ServiceAccount:

```yaml
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::<account>:role/<role>
```

For S3-compatible storages set `externalS3.rcloneProvider` (`Other`, `Minio`, `Ceph`…): this is how the backup agent configures rclone.

### Upgrading

From 1.x see [“Upgrading from 1.x”](#upgrading-from-1x): remove the `carbone:` block from your values. `helm upgrade cr … -f my-values.yaml`. API replicas are rolled out one by one; on shutdown a replica waits for unfinished requests for the larger of `RENDER_TIMEOUT_MS` and `REPORT_TIMEOUT_MS` plus 5 s (before that there is a pause of `api.preStopSleepSeconds`, 5 s by default, while load balancers remove the pod; the `/api/ready` readiness probe responds 503; `terminationGracePeriodSeconds` is calculated from the pause, `config.renderTimeoutMs` and `config.reportTimeoutMs`); migrations are applied by the first replica that started, under a Postgres lock. A rule for developers: a migration must be compatible with the previous version of the application (add, do not rename or delete): old replicas work on the new schema for a few seconds.

### Backups in the cluster

The backup agent keeps backups on the PVC `$R-backups` (`<release>-carbone-reports-backups`, see the naming rule below) (the size is `backup.persistence.size`). The volume is not deleted by `helm uninstall`. The backups are in the same cluster: make copies outside it with cluster tools (volume snapshots, Velero). A restore from the admin UI works with several API replicas.

### Restoring in Kubernetes without the admin UI

If the API does not come up, use the agent's HTTP. `R` is the name of the release resources: `<release>-carbone-reports`, and if the release name already contains `carbone-reports` (or `nameOverride` is set), then the release name without a prefix; with `fullnameOverride` — it. The backups PVC name is `$R-backups`, the agent Service is `$R-backup-agent` (names longer than 63 characters are truncated). Check: `kubectl -n $NS get svc`. The `-f` flag of curl shows an HTTP error (the exit code is non-zero).

```bash
NS=reports
R=cr-carbone-reports
kubectl -n $NS port-forward svc/$R-backup-agent 18080:8080 & PF=$!
sleep 3   # wait for the port forward (or run port-forward in a separate terminal)
TOKEN=$(kubectl -n $NS get secret $R -o jsonpath='{.data.BACKUP_AGENT_TOKEN}' | base64 -d)   # or your existingSecret
A="Authorization: Bearer $TOKEN"
curl -sf -H "$A" http://127.0.0.1:18080/backups                      # list
curl -sf -H "$A" -H 'content-type: application/json' -d '{"requestedBy":"kubectl"}' \
  -X POST http://127.0.0.1:18080/backups/<name>/restore                 # start
curl -sf -H "$A" http://127.0.0.1:18080/operation                     # progress and result (204 — there were no operations)
kill $PF                                                              # when done
```

If the restore was interrupted, the retry code is in `kubectl -n $NS logs deploy/$R-backup-agent | grep 'КОД ВОССТАНОВЛЕНИЯ'` (“КОД ВОССТАНОВЛЕНИЯ” is “RECOVERY CODE”). Retry on the maintenance screen or with a request:

```bash
curl -s -H "$A" -H 'content-type: application/json' -d '{"code":"<code>","target":"same"}' \
  -X POST http://127.0.0.1:18080/recovery
```

`target`: `same` — repeat the restore from the same backup, `pre-restore` — return to the state before it (the `pre-restore-*` backup). Do not put the token into the shell history on shared machines.

### Security

The API is compatible with the “restricted” Pod Security level. Web, the agent, OnlyOffice and the bundled dependencies run as root, like their images: the chart is designed for the “baseline” level. `networkPolicy.enabled: true` repeats the internal networks of compose: only api goes to the agent; web and OnlyOffice go to api; web and api go to OnlyOffice; api and the agent go to Redis, S3 and Postgres (these three policies exist only for the bundled dependencies). The kubelet probes pass (node traffic). With an external OnlyOffice an additional policy in api is needed.

### Checking the chart locally

`pnpm chart:check` (lint, helm-unittest, kubeconform; only Docker is needed).

## Sign-in via LDAP/Active Directory

Optional, disabled by default (`LDAP_ENABLED=false`) — then only the local admin/password works,
as before. The variables are in `.env.example`.

When enabled (`LDAP_ENABLED=true`), `POST /api/auth/login` first looks the user up in LDAP
(`LDAP_BASE_DN` with the `LDAP_USER_FILTER` filter, `%s` is the substituted login) and tries to
bind with the found DN and the entered password. The search, if `LDAP_BIND_DN` is set, is performed as this
service account; otherwise anonymously (if the server allows it).

- **Successful bind.** If there is no local user with this login yet, it is created automatically
  with the role `LDAP_DEFAULT_ROLE` (`user` by default; `admin`, `editor`, `access_manager`, `user` are allowed) and a random local password that nobody knows
  (it cannot be used to sign in directly — only through LDAP). After that the role, the block (`blocked`) and the groups live
  in the DB like those of an ordinary user, and LDAP does not touch them.
- **Failure** (wrong password, user not found, LDAP server unavailable) is not a 401 error by itself:
  the API falls back to the ordinary check of the local password. This is deliberate, so that the built-in
  `ADMIN_LOGIN`/`ADMIN_PASSWORD` does not lose access when LDAP fails.
- A blocked (`blocked`) local user cannot sign in either through LDAP or locally.
- The built-in `ADMIN_LOGIN` signs in only with the local password: a directory user with the same login
  does not get its account.
- `%s` in `LDAP_USER_FILTER` is replaced in all occurrences, for example `(|(uid=%s)(mail=%s))` — sign-in by
  login or by email. The login is escaped (RFC 4515), so `*`, `(`, `)` and `\` do not widen the filter.
- `LDAP_LOGIN_ATTRIBUTE` (optional) is the attribute of the found entry whose value becomes the
  local login (OpenLDAP: `uid`, AD: `sAMAccountName`). It is needed with a filter on several attributes:
  sign-in by login and by email lands in one local account, and the account is looked up case-insensitively.
  If not set, the local login is the one that was entered (as in earlier versions).
- The built-in `ADMIN_LOGIN` is not available through LDAP in any spelling: neither by a login in another case,
  nor by email, if the canonical login of the entry matched `ADMIN_LOGIN`.
- If the LDAP server does not respond, the attempt is dropped after 5 s for the connection and 10 s for the operation,
  after which the local password is checked.
- `ldaps://` with a self-signed certificate of the LDAP server — `LDAP_TLS_REJECT_UNAUTHORIZED=false`.
- Active Directory: `LDAP_USER_FILTER=(sAMAccountName=%s)`. OpenLDAP: `LDAP_USER_FILTER=(uid=%s)` (the default).

## Sign-in via Keycloak (OpenID Connect)

Optional sign-in through Keycloak or another OIDC provider; disabled by default (`OIDC_ENABLED=false`).
Local sign-in and LDAP keep working. Client setup in Keycloak, environment variables, linking
of existing users, sign-out and the checks before an upgrade are in
[docs/operations/keycloak.en.md](docs/operations/keycloak.en.md).

## Interface development

The interface is `apps/web` (React 19, Gravity UI, Vite). The backend and OnlyOffice come from the dev stack:

```bash
pnpm stack:dev                               # API, OnlyOffice, PostgreSQL (nginx on :8080)
pnpm --filter @carbone-reports/web dev       # interface with hot reload at http://localhost:5173
```

Vite proxies `/api` and `/onlyoffice` (including WebSocket) to `http://localhost:8080`; for another stack address use the `STACK_URL` variable.
Interface tests: `pnpm --filter @carbone-reports/web test`. In the production image (`pnpm stack:prod`) the interface is built in `docker/web.Dockerfile`.

The documentation exists in Russian and English (`README.en.md`, `docs/**/*.en.md`); a change to a Russian document is accompanied by a change to the English one, and the pairs are checked by `pnpm docs:check` (details — [`docs/localization.en.md`](docs/localization.en.md#documentation)).

## Demo and E2E

```bash
pnpm stack:demo     # production stack + demo DB + the “Счёт (демо)” template in the “Финансы” category (needs DEMO_DB_PASSWORD in .env)
pnpm e2e            # Playwright E2E (Chromium on the host) against a running stack
pnpm site:shots    # screenshots for the website (site/shots/) against the running demo stack
pnpm stack:down     # stop
```

First E2E run: `pnpm --filter @carbone-reports/e2e exec playwright install chromium`.
The report is `e2e/report/index.html`; on a failure the trace is saved to `e2e/test-results/`.
E2E changes the demo template. Before each run it restores the original file, queries, parameters and access by itself (`e2e/global-setup.ts`); after a run the template stays changed. Manually: `pnpm demo:seed -- --reset-template`.
The `DEMO_DB_PASSWORD` password is given to the demo DB roles only when the volume is first created. If you changed it later, recreate the demo DB volume (other volumes are not touched):

The product website is the `site/` directory (HTML and CSS); it is published to GitHub Pages on release (`.github/workflows/pages.yml`). Re-take screenshots with `pnpm site:shots` before a release if the interface changed; `pnpm site:check` checks links, screenshots and the footer version (it must match the latest version in `CHANGELOG.md`).

```bash
docker compose --profile demo rm -sf demo-db && docker volume rm carbone-reports_demo_pgdata && pnpm stack:demo
```

## The “SQL list” parameter

The options of a parameter of the “SQL list” type (`query`) are taken by a query to the template's data source:

- **Columns.** The query returns `value` (the parameter value) and `label` (the caption in the list). Without a `value` column the value is the first column other than `label`. Without a `label` column the caption is the first column other than the value column, and if there is none, the value itself. Duplicate values are removed. A date arrives as `YYYY-MM-DD`, a timestamp as an ISO string.
- **Dependency.** A reference `:name` to another parameter makes the list dependent. For example, `select id as value, number as label from invoices where company_id = :companyId`. While the required parent is not selected, the field is inactive. After the parent changes, a value that is no longer available is reset.
- **Multiple selection.** In the report form there is a “Select all” checkbox above the list (it selects the whole list, not only what the search found; the next click is “Clear all”). The value is passed as an array. In SQL use `= any(:param)`, for example `where id = any(:ids)`; the `=` sign is required. This also applies to dependent lists: if “Company” has multiple selection enabled, “Invoice” is written as `where company_id = any(:companyId)`. The parameter editor suggests the needed form of comparison, and an SQL error is supplemented with a hint if `=` and `any` are mixed up.
- **Limit.** At most 1000 options. If the query returned more, it is an error: refine the query.
- **Strict check.** When a report is generated, the server recalculates the options with the selected parent values again. A value that is not in the list is rejected with an error at the field.

An example is the demo template “Счёт (демо)” (“Invoice (demo)”): “Компания” (“Company”) → “Счёт” (“Invoice”).

## Moving templates between environments

Templates can be exported from one environment (for example, a test one) and imported into another. This is done by administrators and editors (an editor exports only their own templates and those granted to them): in the template list, check the needed ones and click “Export” (or “Export” in the template card), and in the other environment click “Import from archive”. The result is a file `<name>.crt.zip` (for several templates — `templates-<date>.crt.zip`).

**What is moved.** The document file of the current version, the description, the default format, the “Available to everyone” flag, the category (by name), the access groups (by name), SQL queries, parameters and a description of the data source — only for information and matching: in an administrator's archive the name, host, port, database, user and SSL mode, in an editor's archive only the name (connection settings are not shown to an editor).

**What is not moved.** Data source passwords and their CA certificates (the source in the target environment must be created in advance), identifiers, dates, authors, run history and save errors, earlier versions of the file.

**How matching works on import.**

- The data source is looked up by exact name. If there is no such source or there are several with the same name, choose the source in the import window: until it is chosen, the template cannot be imported.
- The category is looked up by name. If it is missing, it is created on import by an administrator; an editor does not create categories — the template is imported without a category (the preview says “it will not be created”). Groups are looked up by name case-insensitively, missing ones are skipped (the preview window shows which ones are missing).
- If a template with this name already exists, choose an action: “update” (a new version of the file, queries and parameters are replaced, metadata is updated, the run history stays), “copy” (a new template “Name (2)”, the first free number) or “skip”. If there are several templates with this name, for “update” a specific one is selected (the most recent by default). If the name does not exist, “create” or “skip” is available.
- Everything is applied in one transaction: on an error the database contains neither new nor changed templates, and the uploaded files are deleted from storage. If after the preview the template chosen for updating was changed (the file, saving in OnlyOffice, queries, parameters, settings, access), deleted or renamed, if the name for “create” became taken or the chosen data source was deleted, the import responds with 409: click “Repeat preview” — the per-row choice is kept where it is still valid, and the rows that changed are marked. A group deleted after the preview is skipped; a deleted category is created again (for an editor the template is imported without it).
- “Update” replaces the template's file, queries, parameters, access groups, category, the “Available to everyone” flag and data source with the data from the archive: groups that are not in the archive disappear from the template.

**Limits.** An archive up to 50 MB, up to 200 MB unpacked (the `manifest.json` template description — up to 20 MB), at most 1000 entries and 200 templates; template names in one archive must not repeat. The built-in nginx accepts bodies up to 51 MB only on the `/api/templates/import*` routes, and 25 MB on the other `/api/` routes. If you use your own ingress or proxy, raise its request body limit for `/api/templates/import*` (at least 51 MB). Export is available in maintenance mode, import is not. No more than two exports run at a time per API process (the rest wait in the queue). Imports run one at a time.

A known limitation: if someone manually creates a template with the same name during an import, a duplicate name is possible (names are not unique in the database).

## Template editor

The template document is edited by one person. Others who open the “Document” tab see it view-only — with the editor's changes live — and the line “View only — <login> has been editing since <time>”. The lock is extended while the tab is open and is released as soon as you close the tab or leave the template page; only if the tab closed abnormally (a browser crash, a lost connection) does the lock expire after about a minute. The “Take over editing” button (with confirmation) transfers editing to you; the previous editor will see the message “<login> took over editing”. “Expand” opens the editor full screen, “Collapse” returns it.

Tags and “Constructs” from the panel on the right can be dragged with the mouse straight into the document: the tag lands where the button is released. The panel can search tags and collapse.

While another tab is editing the template (including another tab of the same user), replacing the file in “Settings” is rejected with a `409` error; from the template page that holds the lock itself, the file can be replaced. Deleting a template and updating it from an archive (the “update” action on import) are rejected with `409` for any open edit. Close the editor and try again. In the template list such a template is marked “Being edited by <login>”.

## Preview before saving

The report page has no format choice. “Generate” builds the data once and shows the report as a PDF; for an Excel template this is the print view according to the template's print settings. Under the preview is “Save as” with a button for each format of the template: Word — PDF, DOCX, ODT; Excel — PDF, XLSX, ODS; PowerPoint — PDF, PPTX. The main button is the default format from the template settings. Another “Generate” creates a new run.

- **Run snapshot.** When generating, the API saves the data (`reports/<runId>/data.json`) and a copy of the template file (`reports/<runId>/template.<ext>`) and builds the PDF (`out.pdf`) from them. Another format is built from the same snapshot on the first request (`out.<format>`) and is then served ready-made. So the file matches the preview even if the data in the source or the template has changed since.
- **API.**
  - `POST /api/reports/:id/render` accepts `{ params }`; the `format` field is ignored.
  - `GET /api/runs/:id/file?format=<format>&inline=0|1` returns the file in the needed format, without `format` — the PDF. A format not available for the template is `400 VALIDATION` “this format is not available for this report”. A deleted snapshot is `410` “the file was deleted — generate the report again”.
  - Concurrent requests for the same format build the file once: a Postgres advisory lock, which works with several API instances too.
  - In `GET /api/runs` a run has `formats` (can be downloaded) and `readyFormats` (already built).
- **History.** For a run with a snapshot the “Download” button opens a menu with all formats. Runs made before the update can be downloaded only in their own format, as before.
- **Storage.** Cleanup by `REPORT_RETENTION_DAYS` and deletion of a user delete the whole `reports/<runId>/` directory.
  - Volume per run. Each successful run keeps in `reports/<runId>/` a copy of the template (up to 20 MB, the multipart upload limit), `data.json` (for each query no more than `QUERY_MAX_ROWS` rows, 100,000 by default, so the file can take tens of MB), `out.pdf` and every format downloaded later. Previously a run kept one output file.
  - Growth. The data volume and the nightly `storage.tar.gz` backup grow roughly in proportion to the number of runs over `REPORT_RETENTION_DAYS` (30 by default) — this is the main parameter that controls the volume.
  - Concurrency. Each API instance has a separate pool of 3 DB connections for building files: no more than 3 different files are built at a time per instance, the other requests wait until the report deadline (otherwise `504`).

## Report access

Administrators see all templates. A user sees a template in the catalog and can generate a report from it if at least one condition is met:

- the template has “Available to everyone” turned on;
- the template is in a category with “Available to everyone”;
- the user is in a group to which the template's category is opened;
- the user is in a group to which the template itself is opened.

For a user an unavailable template is indistinguishable from a nonexistent one: the card, generation and SQL list options respond with 404.

- **Where it is configured.** Groups and their members — the “Groups” section (or the “Groups” field in the user dialog). Categories, their “Available to everyone” and groups — the “Categories” section. A template's access (category, “Available to everyone”, groups) — the “Settings” tab → “Access” (the administrator, the template owner and the editors granted to it) or the “Report access” section (the administrator and the security manager), see [“Roles”](#roles). If a template is open to nobody, the same place shows the warning “The template is currently available only to administrators”: only administrators will be able to build a report from it, while the template's owner and editors still edit it and view the preview.
- **Catalog.** Reports are grouped by categories (by sort order, then by name), templates without a category are in the last section “Uncategorized”; a category named “Прочие” (“Other”) is an ordinary section. If there is one section, there are no headings.
- **After the update.** The migration makes all existing templates “Available to everyone”, so after the update users see the same as before. New templates (creation and import) are closed until access is opened by an administrator, the owner or a granted editor of the template (the “Settings” tab) or by a security manager (the “Report access” section). A copy of a template inherits the category, “Available to everyone” and the groups of the original.
- **History.** Closing access does not touch the history: a user still sees their past runs and downloads their files, but can no longer generate a new report from the template.
- **Demo.** `pnpm stack:demo` creates the “Финансы” (“Finance”) category and the “Бухгалтерия” (“Accounting”) group and puts “Счёт (демо)” (“Invoice (demo)”) into “Финансы” with “Available to everyone”.

## Roles

A user has one of four roles: “Administrator” (`admin`), “Editor” (`editor`), “Security manager” (`access_manager`), “User” (`user`). The role is changed by the administrator in the “Users” section. A new account (the first sign-in via LDAP or OIDC) gets `user`; for LDAP the role can be set with `LDAP_DEFAULT_ROLE`. An administrator cannot change their own role to any other.

| Action                                                            | Administrator | Editor                                       | Security manager | User |
| ----------------------------------------------------------------- | ------------- | -------------------------------------------- | ---------------- | ---- |
| Create a template (empty, from a file, by import)                 | yes           | yes, becomes the owner                       | no               | no   |
| Edit a template: file, queries, parameters, charts, PDF, preview  | any           | own and granted to them                      | no               | no   |
| Copy, export, update by import                                    | any           | own and granted to them (the copy is theirs) | no               | no   |
| Delete a template                                                 | any           | only their own (the owner)                   | no               | no   |
| Category, groups, “Available to everyone” of a template           | any           | own and granted to them                      | any              | no   |
| Assign template editors                                           | any           | only their own (the owner)                   | no               | no   |
| Groups and categories: directories, group membership              | yes           | view lists only                              | yes              | no   |
| Data sources                                                      | yes           | choose from the list only (no settings)      | no               | no   |
| Users, roles, backups, other people's certificates, OIDC bindings | yes           | no                                           | no               | no   |
| Build a report                                                    | any template  | by the rules of [access](#report-access)     | same             | same |

- **Editor.** In the “Templates” section they see only their own templates and those granted to them. The template preview is available to them without groups, but they can build a report only if access is given by groups or a category (or “Available to everyone”). They choose a data source from the list and do not see the connection settings (in an editor's export archive the source also has only the name). At the same time, in the template's queries and their trial run an editor can execute any SELECT queries against any data source in the list — with the rights of the account set in the source. Grant this role with that in mind. On import they can update only their own and granted templates, and a missing category is not created: the template stays without a category. An editor cannot delete a granted template.
- **Template owner and editors.** The owner is the one who created the template. The owner or an administrator grants the right to edit to other users on the template's “Settings” tab in the “Editors” block; only users with the “Editor” role can be chosen. An administrator can “Change owner”. If an editor is demoted to another role or their right to edit is taken away, the rights disappear immediately (the grant records of a demoted user remain but have no effect and do not prevent the owner from saving the list of editors): their open document editor is closed with the message “no right to edit the template”, and changes that OnlyOffice sends afterwards are not saved — the template gets the save error “changes not saved: no right to edit the template”.
- **Templates created before 2.12.0** have no owner: until an administrator assigns an owner or editors, only an administrator edits them.
- **Security manager.** The “Groups”, “Categories” and “Report access” sections are available to them. In “Report access” they see all templates (name, category, groups, “Available to everyone”) and change these fields; the content of templates (file, queries, parameters) is not available to them. They build reports as an ordinary user. A security manager maintains group membership, so they can include themselves in any group and thereby get access to build any report. Grant this role with that in mind.
- **Example.** An editor sees in the “Templates” section only their own templates and those granted to them; they can build a report only if access is given by groups or a category.
- **Update.** Migration `0015` (`templates.owner_id`, the `template_editors` table) runs automatically at API start; no administrator action is required.

## Interface language

The interface, the API error texts and (since 2.15.0) the “Template help” are in seven languages: Russian (the main one), English, Español, Português (Brasil), Français, Deutsch, 简体中文. The translations into all languages except Russian have not yet been reviewed by native speakers.

- **Switcher.** In the bottom menu of the side panel there is the “Language” item: the choice changes the language immediately and is saved in the user's profile. The sign-in page also has a switcher, and its choice is stored only in the browser. The “Browser default” item resets the choice.
- **How the language is chosen:** the language from the profile → the choice on the sign-in page (it also applies after sign-in while no language is chosen in the profile) → the browser language that has a translation (`pt-PT` → `pt-BR`, `zh-TW` → `zh-CN`, `de-AT` → `de`) → `DEFAULT_LOCALE`.
- **`DEFAULT_LOCALE`** is the default language: `ru` (the default), `en`, `es`, `pt-BR`, `fr`, `de` or `zh-CN`; in Helm — `config.defaultLocale`. The interface opens in it if the browser language is not supported, and the API responds in it if the request has no `X-Locale` and no suitable `Accept-Language`. The public `GET /api/i18n` returns `{ defaultLocale }`.
- The OnlyOffice document editor opens in the interface language; dates, numbers and file sizes are formatted by it too. The date in the report parameters form is entered as DD.MM.YYYY in all languages.
- **What is not translated yet:**
  - only `CHANGELOG.md` and the working notes in `docs/superpowers/` stay in Russian (details — [`docs/localization.en.md`](docs/localization.en.md#documentation));
  - these stay in Russian: the server log, configuration errors, CLI script messages, texts saved to the database (the run error in “History”, the document save error in the editor, the “(копия)” suffix), backup agent responses, the texts of Carbone engine errors in a template and the GOST key algorithm label.

How the translation catalogs are organized, how to add a language and send corrections is in [`docs/localization.en.md`](docs/localization.en.md).

## Report language

Since 2.14.0 a template has a “Report language” (the “Settings” tab of the template editor): one of the seven languages or “Same as the user”. Details are in the “Report language” section of [`docs/localization.en.md`](docs/localization.en.md#report-language).

- **What it sets:** the Carbone date and number format (`formatD`, `formatN`), the default `formatC` currency, the OnlyOffice conversion region, the signature stamp lines and the default PDF page numbering format (`en` — “Page {page} of {pages}”, `zh-CN` — “第 {page} 页，共 {pages} 页”, and so on). The text of the template itself is not translated.
- **The currency follows the language:** `ru` — RUB, `en` — USD, `es`/`fr`/`de` — EUR, `pt-BR` — BRL, `zh-CN` — CNY (the symbol “¥”). When you change a template's language, check the amounts or set the currency in the tag (`formatC(…,'RUB')`).
- **“Same as the user”:** the language from the profile of the person building the report; if there is none, the request language (`X-Locale`, `Accept-Language`), otherwise `DEFAULT_LOCALE`.
- **A run remembers the language:** the signature (`.p12` and GOST, including later from “History”) and downloading another format from the snapshot are in the language in which the report was built. Runs before 2.14.0 are in Russian.
- **Templates before 2.14.0** get the Russian language (migration `0017`), their reports do not change. A new template gets `DEFAULT_LOCALE`, a copy — the language of the original, an import from an archive — the language from the export (in exports before 2.14.0 — Russian).
- **Chinese text in PDF:** the stamp, numbering and a watermark with Chinese characters are drawn with the Noto Sans SC font (in the API image, OFL). Characters that are in neither Noto Sans nor Noto Sans SC (for example, emoji) are not saved in the PDF settings. A line with Chinese characters is drawn entirely with Noto Sans SC, so characters that it lacks (for example, “₽”, “ї”, “Ł”) are shown as “?” in such a line. Chinese text in charts is not supported.

## Template help

The administration section “Template help” (`/admin/help`) contains examples of Carbone tags verified on our free edition (Community Edition): basics, tables, formatting, conditions (including `drop`/`keep`), totals and numbering (the aggregators `aggSum`, `cumSum`, `:count()` and others), grouping through SQL, images, barcodes, colors and links, charts, HTML from data. The last section is what is unavailable in the free edition and what to use instead. In the template editor the “Syntax help” link opens the help in a new tab, and the document in OnlyOffice stays open. If a Russian letter stands among Latin ones in a template tag (for example, “с” in `{d.data[].сnt}`), a warning with the list of such tags appears above the editor tabs.

- **Help language.** Since 2.15.0 the help is in seven languages, in the interface language (it changes together with it). The example results are for the report language of the same language: in the English help dates are `MM/DD/YYYY` and amounts `$1,234,567.89`, in the German one `1.234.567,89 €`, and so on. If the language module failed to load, the Russian help is shown with a message. The help translations have not yet been reviewed by native speakers; how to translate it into a new language is in [`docs/localization.en.md`](docs/localization.en.md#template-help), the “Template help” section.
- For the Russian report language (see [“Report language”](#report-language)) the API passes Carbone `lang: 'ru'`: `formatN(2)` gives `1 234 567,89`, `formatC()` — `1 234 567,89 ₽`. **The output of existing templates changes after the update:** `formatN`/`formatC` now print Russian separators and ₽ (`formatN(2)` for `1234567.891` was `1,234,567.89`, now `1 234 567,89`; `formatC()` was `1,234,567.89 €`, now `1 234 567,89 ₽`); amounts in `formatC(…,'USD')`/`convCurr` are now converted from roubles, not from euros, by the built-in rates (1000 was `1,140.30 $`, now `14,68 $`); dates do not change.
- If a template has a formatter that is disabled in the free edition (for example, `chart`), generation and preview respond with `400` and the code `CARBONE_COMMUNITY`: “the template uses chart — not available in the free edition of Carbone, see “Template help””. The run goes into the history with this text.
- `pnpm help:check` renders every help example with the built-in Carbone build (`packages/carbone`, without a running stack and Docker; since 2.15.0 — in all seven languages, each language with the `lang` of its own report language and the same `TZ` as the API) and compares the text of the result with the expected one (for examples with a picture — only that the report was built without an error and the placeholder was replaced; for HTML examples — that the report was built without an error and contains text); on a mismatch the exit code is 1. `pnpm help:check -- --locale de` checks only one language, `pnpm help:check -- --self-test` — only the DOCX build. The check does not run in CI, but the package's own tests are part of `pnpm test`.
- The behavior references are in `packages/carbone/test/golden` (the recorded output of Carbone EE 5.15.3 in Community mode: the help examples and the probe matrix; the format and rules are in `packages/carbone/test/golden/README.md` (in Russian)). Deliberate differences from EE are marked with the `deviation` field with a reason; the list of known discrepancies `known-gaps.json` is empty. New probes are taken by `pnpm exec tsx scripts/carbone-parity.ts <file.json>` — a script for developers, it starts the Carbone EE image (3.7 GB), not used in CI.

## Images, barcodes, colors, and links in templates

Since 2.4.0 the built-in Carbone supports these paid features of Carbone EE (written anew, see [`packages/carbone/NOTICE.md`](packages/carbone/NOTICE.md) (in Russian)); examples are in the “Template help”.

- **Images from data.** A placeholder picture of the needed size is inserted into the template, and the tag (`{d.photo}`) goes into its alternative text: in Word “Format Picture” → “Alt Text”, in LibreOffice “Properties” → “Options” → “Text alternative” or “Description”, in the template editor (OnlyOffice) “Image Advanced Settings” → “Alternative Text”. The value is a data URI (`data:image/png;base64,…`; PNG, JPEG, GIF) or an `http(s)://` address on a host from `IMAGE_URL_ALLOWLIST` (see [“Configuration”](#configuration); loading by address is off by default). `:imageFit(fillWidth|contain|fill)` is how to fit the image into the placeholder frame (`fillWidth` by default: the frame width, the height by proportions). An empty value removes the placeholder. The tag must occupy the whole alternative text: mixed text (“Photo {d.name}”) and a value that is plain text (not `data:` and not `http(s)://`) are printed in the alternative text, as before, and the picture stays. Limits: 10 MB and 100 million pixels per image, 50 MB per report. Template formats: DOCX, XLSX, PPTX, ODT, ODS, ODP; several pictures in a loop — in DOCX (the picture “in line with text”) and ODT (anchored “as character”).
- **Barcodes.** `{d.code:barcode(qrcode)}` in the alternative text of a placeholder picture replaces it with a PNG barcode (the `bwip-js` library; types as in the Carbone documentation — `qrcode`, `ean13`, `code128`, `datamatrix` and others; the options `width` and `height` in mm, `scale`, `includetext`, `rotate`, colors `#RRGGBB`, `eclevel`). `barcode` in plain text is a template error.
- **Colors.** `{d.c:color(cell, background)}` colors a paragraph, cell, table row or shape (`p`, `cell`, `row`, `shape`; `part` — ODT only): the text, background, highlight or outline — depending on the format (DOCX — text and background). The color is 6 hex digits with or without `#`, otherwise `#888888`. PPTX does not support `p` with `background`, DOCX does not support `shape` (a template error). In XLSX and ODS it is a template error.
- **Links.** The hyperlink address from data (`{d.url}` in the link address field) is checked: without a scheme `https://` is added; `http`, `https`, `mailto`, `tel` are allowed; the host must have a top-level domain. An invalid address is replaced with the value of `:defaultURL(...)`, and without it with `#`. **Addresses with `localhost`, an IP address or a host name without a top-level domain (an internal `http://server:8080`) also become `#`** — for internal links use the full host name (`server.corp.example`). Relative addresses and anchors (`#section`, `../file.pdf`) also become `#`. In an address with a static part (`https://site.ru/?id={d.id}`) the tag value is encoded (`encodeURIComponent`) and the whole address is checked; a tag at the very beginning of an address (`{d.base}/items/{d.id}`) is inserted as is.
- **Errors.** An error in a tag (an invalid image, a host outside the list, a wrong barcode type or value, an unsupported `:color`) is `400` `CARBONE_TEMPLATE` “template error: …” with the tag in the text (before 2.4.0 tag errors gave `502` `CARBONE_ERROR`).
- **Not supported:** `:autoOrient`, SVG images, barcodes with a font, `bindColor` (it colors nothing, use `:color`), `failOn`, images in HTML output.

## Charts and HTML in templates

Since 2.5.0 the built-in Carbone supports two more paid features of Carbone EE (written anew, see [`packages/carbone/NOTICE.md`](packages/carbone/NOTICE.md) (in Russian)); examples are in the “Template help”, the “Charts” and “HTML” sections.

- **Word and Excel charts.** The chart is drawn in Word or Excel, and the tags are put into its data as loop rows, as in a table (`{d.rows[i].m}`, under it `{d.rows[i+1].m}`): in Word — in the “Edit Data” sheet, in Excel — in the sheet cells that the chart refers to. After the build the series cover all the data rows, the values stored in the chart are recalculated (the chart is correct in the PDF too), and the embedded Word sheet contains the report data. A value in a value series becomes a number if it looks like one (`1 234,5`, `-3`, `1e3`; the comma is the decimal separator); otherwise it stays text and gives no point. Types — all ordinary charts: column, bar, line, area, pie, doughnut, scatter, bubble, combination, flat and 3-D. **Not supported:** the new Office 2016 types (treemap, sunburst, histogram, box and whisker and others), loops over columns, a number of series from data, multi-level category labels, Excel tables and named ranges (they do not stretch), charts linked to an external file, PPTX and OpenDocument charts. ECharts charts — the section below.
- **HTML from data.** `{d.text:html}` in the text of a DOCX or ODT paragraph (body, table cells, headers and footers; PDF — by conversion from them) inserts HTML with formatting: `b`, `i`, `u`, `s`, `sup`, `sub`, `mark`, `code`, `p`, `br`, `pre`, `hr`, `blockquote`, `h1`–`h6`, `ul`/`ol` lists with nesting, tables with `colspan`/`rowspan`, links (checked like template links, the fallback address is `:defaultURL(...)`), `img` images (a data URI or a host from `IMAGE_URL_ALLOWLIST`, the same formats and limits), checkboxes; from the `style` attribute — `color`, `background-color`, `break-before`/`break-after: page`. Other tags are dropped and the text stays; `script` and `style` are removed with their content. Parameters: `inline`, `nospace`, `headingtheme:<prefix>`, `tabletheme:<style>` (DOCX), `quotetheme:<style>`. The formatting of the tag (font, size, color, alignment) passes to the inserted HTML. In an HTML template the value is inserted as is; in XLSX, PPTX, ODS, ODP it is a template error. A value larger than 1 MB, nesting deeper than 32 or more than 4096 unclosed tags is a template error; an invalid image or a load failure — the picture is skipped with a warning in the API log.
- **Limits of `:html`.** The tag is allowed only in the text of a paragraph (not in alternative text, a link address, a report name), and `:html` is the last formatter. A table has at most 63 columns: the content of the extra cells goes into the last one. With `inline` inside a template hyperlink the links from HTML become text. In ODT checkboxes are the ☒/☐ characters, `tabletheme` has no effect. The look of documents in Word and LibreOffice was checked selectively: the tests contain structural checks and conversion to PDF through OnlyOffice.

## ECharts charts in templates

Since 2.6.0 the built-in Carbone draws ECharts 5 charts (a paid Carbone EE feature, written anew, see
[`packages/carbone/NOTICE.md`](packages/carbone/NOTICE.md) (in Russian)); examples are in the “Template help”, the “ECharts charts” section.

- **Placeholder.** Insert into the document (DOCX, XLSX, PPTX, ODT, ODS, ODP) a picture of the needed size and write the tag
  `{d.charts.sales:chart}` into its alternative text. After the build, in its place is a PNG of the chart (scale 2 for printing;
  a side longer than 2000 px — scale 1); without `width`/`height` in the description the chart size is the picture size, with them
  the picture keeps the width of the placeholder and the height follows the chart proportions; `:imageFit` works as for images.
  An empty value removes the picture. Pictures inside the description — only a PNG, JPEG or GIF data URI, otherwise a template error.
- **Builder.** The “Charts” tab of the template editor: a “List of rows” query, a labels column, series (or “series from
  data” by a column), the type — columns, horizontal columns, lines, areas, pie, doughnut, combination;
  title, legend, palette, axis names, number format (decimal places, thousands, suffix). The preview uses
  test data; charts are saved with the “Save charts” button (`PUT /api/templates/:id/charts`, the whole list).
  When generating a report and in the preview the API puts the description of each chart into `d.charts.<key>`; the query key
  `charts` is taken when there are charts. Up to 20 charts per template.
- **Ready description.** The tag value is `{ "type": "echarts@v5", "option": { … } }` or the ECharts description itself with
  `series` (convenient to build in SQL with `json_build_object`), a string with JSON is also fine; `width`/`height`
  (100–4000) is the logical canvas size, `theme` is `"dark"` or a theme object.
- **Limits.** A description up to 1 MB, up to 20 series and 10,000 points, rendering up to 5 s; functions in the description do not work
  (JSON only); the font is always Noto Sans from the image (server fonts are not needed); date labels in builder charts are
  DD.MM.YYYY without time zone conversion. Chart PNGs count toward the common 50 MB image limit of a report. A description
  error is `400` `CARBONE_TEMPLATE` with the tag; `:chart` in plain text is the error “график ставится в замещающий текст
  картинки” (“a chart is placed into the alternative text of a picture”; Carbone engine error texts are in Russian).
- **Transfer.** Charts are part of the template transfer archive (`charts` in `manifest.json`); archives of 2.3.0–2.5.x without
  charts import as before.

## PDF settings

The “PDF” tab of the template editor sets what the report's PDF will be like — in the preview, when generating and when downloading:

- **PDF/A-2b** — for archives and electronic document management; PDF/A is made by OnlyOffice Document Server.
- **Watermark** — text diagonally or horizontally, transparency 10–50 %, gray, red or blue.
- **Page numbering** — a format by the report language (“Page {page} of {pages}” for English) or your own format, at the bottom or at the top, the first page can be left unnumbered. Numbering is continuous together with the attached files.
- **Metadata** — title (the template name by default), author, subject, keywords.
- **Attached files** — the template's permanent PDFs (a title page, terms, appendices) at the beginning or at the end of the report: up to 10 files of 20 MB each, up to 500 pages in total, without a password; with PDF/A — only PDF/A files.
- **Protection** — a password to open (one per template, 4–64 characters, not starting with “-”) and restrictions on printing, copying text and editing (AES-256, the `qpdf` program in the API image). Restrictions without a password are honored by viewers — this is not cryptographic protection. Protection applies to generated reports, the preview is without it; it cannot be combined with PDF/A. The password is stored encrypted with `ENCRYPTION_KEY`, the API does not return it, it is not moved with the template (when a template is updated the previous password stays).

In the watermark and metadata you can write `{d.field}` tags without formatters: `Invoice № {d.number}`, `{d.status}` (an empty value removes the watermark). “Save as DOCX/XLSX…” gives the file without the PDF settings. The PDFs of already generated reports do not change when the settings change. The settings and files move with the template (export and import) and are copied on “Duplicate”.

## PDF electronic signature

Since 2.9.0 a report can be signed with an electronic signature in the PAdES format: the signature is put on the PDF with the user's own certificate. Under Federal Law No. 63-FZ this is an enhanced non-qualified signature — its legal force inside the organization and with counterparties is given by an agreement of the parties.

Since 2.11.0 a signature under GOST R 34.10-2012 through the CryptoPro CAdES Browser plug-in is also available: the key stays on the user's computer, the result is a stamped PDF and a detached `.sig` signature. The method is chosen in the template (“Signing method”). The administrator downloads the `cadesplugin_api.js` script from CryptoPro and puts it into `./cades/` (Helm — `web.cadesPluginConfigMap`); the timestamp service is `SIGN_GOST_TSA_URL`. What the user needs, what the server verifies and how to check a pair on Gosuslugi is in [docs/operations/gost-signature.en.md](docs/operations/gost-signature.en.md).

- **Certificate.** The user takes a `.p12` (`.pfx`) file with the private key from a certification authority or the IT service and uploads it on the “My signature” page (RSA from 2048 bits or ECDSA P-256/P-384, not expired). The file is stored in the DB encrypted with `ENCRYPTION_KEY` and is given to nobody; the key password is entered at every signing and is not saved anywhere.
- **Template.** Signing is allowed by the “PDF” tab of the template editor (“Electronic signature” → “Allow signing the PDF”); it is incompatible with a password and restrictions, and compatible with PDF/A. A 250 × 80 pt stamp is placed at the bottom of the last page (left, center or right) over the content — leave 110 pt at the bottom.
- **Signing.** “Sign PDF” on the report page or “Sign…” in the history; only the person who generated the run can sign. The limit is 5 wrong passwords per 15 minutes per user; the counter is stored in the database (the `sign_password_failures` table), shared by all API instances and independent of Redis. A second simultaneous signing by the same user immediately gets `409` “another signing is in progress — try again in a few seconds”. Upload and signing parse the `.p12` in the render pool (an upload waits for a free thread no longer than `REPORT_TIMEOUT_MS`).
- **Timestamp.** `SIGN_TSA_URL` is the optional address of an RFC 3161 timestamp service (`http` or `https`; an invalid address — the API does not start). Empty — signing without a timestamp. `SIGN_TSA_TIMEOUT_MS` is the timeout of a call to the service, `10000` by default, 1000–60000 allowed. The API needs outgoing access to the timestamp service (the chart's NetworkPolicy does not restrict outgoing traffic). An example of a public service is `http://timestamp.digicert.com`; the choice of the service and its compliance with its terms of use are up to the administrator. If the service is unavailable, the report is not signed (`502` `TSA_UNAVAILABLE`). In Helm — `config.signTsaUrl` and `config.signTsaTimeoutMs`, in Docker — the variables from `.env`.
- **Verification.** Adobe Acrobat Reader shows the signature in the “Signatures” panel; it is “valid” if the certification authority's certificate is trusted by the recipient.
- **Update.** Migration `0011` (user certificates, run signatures, stamp position) is applied automatically.

## Data source security

Template queries and queries for parameter value lists may only read data. When saving,
importing templates from an archive and before execution, a query is checked:

- one command (`;` — only at the end), starting with `SELECT`, `WITH`, `VALUES`, `TABLE` or `(`;
- no `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `INTO` and no `FOR UPDATE`, `FOR NO KEY UPDATE`,
  `FOR SHARE`, `FOR KEY SHARE` locks — outside strings, comments and names in double quotes;
- no calls of dangerous functions: `dblink*`, `pg_sleep*`, `pg_advisory_*`, `set_config`, `nextval`,
  `setval`, `lo_*`, `pg_read_file`, `pg_ls_*`, `query_to_xml*`, `pg_terminate_backend` and others
  (the full list is `FORBIDDEN_SQL_FUNCTIONS` in `packages/shared/src/sql-readonly.ts`).

Put a column named like `update` or `into` in double quotes: `select "update" from t`.

The check does not replace database permissions. Connect sources under a separate PostgreSQL user
with the `SELECT` right only:

```sql
create role reports_reader login password '…';
grant connect on database shop to reports_reader;
grant usage on schema public to reports_reader;
grant select on all tables in schema public to reports_reader;
alter default privileges in schema public grant select on tables to reports_reader;
```

In addition, queries are executed in a `READ ONLY` transaction with `statement_timeout`.

A source's SSL is set by one of three modes:

- “No SSL” (`disable`);
- “SSL without verification of the certificate” (`require`): the traffic is encrypted, but there is no protection against server spoofing,
  so use this mode only in an internal network;
- “SSL with verification of the certificate” (`verify`): the server certificate is verified. For a self-signed
  or internal certificate, specify your own CA in PEM format.

In the API the `sslMode` field is required.

## Upgrading from 1.x

Version 2.0.0 removes the Carbone container: reports are built by the API. The upgrade procedure:

1. Make a [manual backup](#backups) and get the new images: `docker compose pull` (prebuilt images) or build your own.
2. Start the updated stack and remove the Carbone container with one command: `docker compose up -d --no-build --remove-orphans` (when building from source — `docker compose up -d --build --remove-orphans`).
3. Delete the Carbone templates volume manually: `docker volume rm <project>_carbone_templates` (for the default project — `carbone-reports_carbone_templates`).
4. `CARBONE_URL` is no longer read; remove it from `.env` and from your manifests. There is nothing to add: `API_SELF_URL` and `RENDER_WORKERS` have defaults (see [“Configuration”](#configuration)).
5. The `cr:carbone:tpl:*` template cache keys in Redis are not used; their lifetime is 7 days, so you can do nothing. To delete them at once: in compose `docker compose exec -T redis sh -c "redis-cli --scan --pattern 'cr:carbone:tpl:*' | xargs -r redis-cli del"` (the container takes the password from `REDISCLI_AUTH`); in the chart's bundled Redis — `kubectl exec -n <ns> $R-redis-0 -- sh -c "redis-cli --scan --pattern 'cr:carbone:tpl:*' | xargs -r redis-cli del"` (`$R` is the release name with the `-carbone-reports` suffix, see [“Restoring in Kubernetes without the admin UI”](#restoring-in-kubernetes-without-the-admin-ui)); in an external Redis — the same `redis-cli --scan … | xargs -r redis-cli del` with your address and password.
6. In Helm remove the `carbone:` block from your values (the component is gone; it had no volumes, so there is nothing to clean). The build is now done by the API: if you set `api.resources`, put a memory limit of at least 2Gi (the new default; `requests` — 500m / 512Mi).

Templates and reports in S3 do not change. What changed in the output:

- **PDF is built by OnlyOffice.** The layout is closer to what you see in the editor and may differ slightly from 1.x reports (LibreOffice in Carbone). OnlyOffice is required for any report: the API builds the PDF first.
- **`ifEmpty` no longer breaks the formatter chain.** Previously the following formatters were not called after `ifEmpty`; now they are called, as in Carbone EE.
- **Quoted arguments that start with a dot are literals.** `:formatN('.x')` passes the string `.x`, not a data path (as in EE). An unquoted path (`.x`) works as before.
- **IPv6.** The automatic `API_SELF_URL` in the chart is designed for IPv4 pod addresses (see [“Configuration”](#configuration)).

## License

The project is distributed under the [PolyForm Strict License 1.0.0](LICENSE.md). Allowed: using the product without changes for non-commercial purposes. Not allowed: making changes, distributing the product and using it for commercial purposes — this requires a separate agreement with the rights holder. Information about other licenses is in [`NOTICE.md`](NOTICE.md) (in Russian). The `packages/carbone` directory is not covered by this license: it stays under the CCL.

The `packages/carbone` directory is part of the product: a modified copy of **Carbone Community Edition** 3.8.2, distributed under the **Carbone Community License** (CCL): [`packages/carbone/LICENSE.md`](packages/carbone/LICENSE.md), the original is https://github.com/carboneio/carbone/blob/master/LICENSE.md. The use of this part of the product is governed by the CCL; under clause 2.1(b) of the CCL the users of the product must be notified of this, so the condition is given here. The package is not distributed separately (`"private": true`). The origin of the code, the differences from upstream and the clean-implementation rule are in [`packages/carbone/NOTICE.md`](packages/carbone/NOTICE.md) (in Russian). The rest of the repository code is not affected by the CCL.

## Configuration

`DEFAULT_LOCALE` is the default language for the interface and API responses (`ru`), see [“Interface language”](#interface-language).

`MIGRATIONS_DIR` is an optional folder with DB migrations, `./drizzle` by default relative to
the current directory of the process.

`STORAGE_BACKEND` — where the API stores files: `local` (the default, the `STORAGE_DIR` directory) or `s3`.
For `s3`: `S3_BUCKET` is required (otherwise the API does not start: “S3_BUCKET: обязателен при STORAGE_BACKEND=s3”, in Russian: “S3_BUCKET: required with STORAGE_BACKEND=s3”);
`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are set together or not at all (then credentials are taken from the pod environment, for example IRSA); `S3_ENDPOINT` is the address of the S3-compatible storage
(empty — AWS S3), `S3_REGION` (`us-east-1` by default), `S3_FORCE_PATH_STYLE` (`true` for SeaweedFS,
`false` by default), `S3_CREATE_BUCKET` (`false` by default). At startup the API checks the bucket:
if it does not exist, with `S3_CREATE_BUCKET=true` it creates it, otherwise it exits with the error “бакет S3_BUCKET не найден” (“bucket S3_BUCKET not found”).
Access keys do not get into the log. In Docker all these values are set by `docker-compose.yml`.

`DATABASE_PASSWORD` and `REDIS_PASSWORD` are passwords separate from `DATABASE_URL` and `REDIS_URL` (a URL without the password; the password is inserted into the URL with encoding, any characters are allowed). `TRUSTED_PROXY_HOPS` is the number of trusted proxies in front of the API (1–5, 1 by default). At startup the API applies migrations under a Postgres advisory lock, so several replicas start safely.

`REPORT_TIMEOUT_MS` is the overall time limit for generating a report and preview in milliseconds (120000
by default, that is 2 minutes). It includes parameter validation (SQL list option queries),
data queries and the Carbone render. When it is exceeded the API responds with `504` and the code `TIMEOUT` (“report generation
timed out”). Source queries still running at that moment are stopped no later than
`QUERY_TIMEOUT_MS` after the deadline.
The same limit applies to building a file of another format from a snapshot (`GET /api/runs/:id/file?format=…`).
The countdown starts from the beginning of the download request; waiting while another request builds the same file
is included in the limit.
`RENDER_TIMEOUT_MS` (120000 by default) limits the Carbone build and the OnlyOffice conversion each separately; the overall request limit is still `REPORT_TIMEOUT_MS`. On shutdown the API waits for unfinished requests (including reports at the SQL stage) for the larger of `RENDER_TIMEOUT_MS` and `REPORT_TIMEOUT_MS` plus 5 s; in `docker-compose.yml` `api` therefore has `stop_grace_period: 130s` — if you increase these limits, increase it too.

`API_SELF_URL` is the address of this API instance at which OnlyOffice fetches the report file for conversion (`http://api:3000` by default; set explicitly in compose). The file is served by a one-time token. In Helm the value is built from the pod IP: `http://$(POD_IP):3000`, so it is designed for IPv4 pod addresses: in an IPv6-only cluster set the chart value `api.selfUrl: 'http://[$(POD_IP)]:3000'` (the brackets are required; `$(POD_IP)` is substituted by Kubernetes). An external Document Server (`onlyoffice.enabled: false` in the chart or your own Document Server in a compose override) must reach every API replica directly at this address — the pod IPs, not only the Service. `RENDER_WORKERS` is the number of Carbone build threads (1–16, `min(4, number of cores)` by default; empty — the default). In a pod with a CPU limit the node's core count is overstated, so set the value explicitly (in Helm — `config.renderWorkers`). `RENDER_WORKER_MEMORY_MB` is the heap limit of one build thread, MB (128–8192; empty — the default; in Helm — `config.renderWorkerMemoryMb`). A report that exceeds the limit fails with the error “the generation service is unavailable”, the thread is recreated, and the other reports and the API itself keep working. By default the value is derived from the container memory limit: `(limit − 400 MB) / RENDER_WORKERS` within 256–2048 MB (with the chart limit of 2Gi and 4 threads — 412 MB); if the limit is not set or cannot be determined (for example, `docker compose` without `mem_limit`) — 1024 MB. The API writes the effective value to the log at startup (“потоки рендера Carbone”, “Carbone render threads”). When setting it manually, keep `RENDER_WORKERS × RENDER_WORKER_MEMORY_MB + ~400 MB` within the container memory limit. Images from data occupy memory outside the heap: up to ~150 MB per thread (up to 50 MB of images, the built file and its transfer); `RENDER_WORKER_MEMORY_MB` does not limit this reserve. `CARBONE_URL` has been removed and is no longer read.

`IMAGE_URL_ALLOWLIST` — the hosts from which the built-in Carbone loads images from data by an `http(s)://` address (a tag in the description of a placeholder picture, for example `{d.logo}`). Hosts separated by commas, an exact name match without wildcards; the port is part of the host only if it is given (`cdn.example.org` allows only the default port, `img.example.org:8443` — only 8443). Empty by default — loading by address is off, and such an address in data gives the template error “загрузка изображений по адресу выключена (IMAGE_URL_ALLOWLIST)” (“loading images by address is disabled (IMAGE_URL_ALLOWLIST)”; Carbone engine error texts are in Russian); a host outside the list is also a template error. **Trust is determined only by the allowlist:** addresses that resolve to private or local IPs are not forbidden separately — do not put hosts into the list that data authors can control. Loading is `http:`/`https:` only, without redirects, no more than 4 at a time per report, up to 10 MB per image; `IMAGE_URL_TIMEOUT_MS` is the timeout of loading one image (5000 ms by default; all together they fit within `RENDER_TIMEOUT_MS`). A load failure (a timeout, a non-2xx response including 3xx, exceeding the size, a network error) does not stop the report: the placeholder picture is removed, and the warning “изображение не загружено” (“image not loaded”) with the address without the query string is written to the API log. A `200` response that is not a PNG, JPEG or GIF (for example, a CDN error HTML page or an SVG) is not a load failure but a template error `400` with the address (without the query string) in the text: the report is not built. An error in one picture (a host outside the list, not an image, exceeding 50 MB per report) immediately aborts the other loads. In Helm — `config.imageUrlAllowlist` and `config.imageUrlTimeoutMs`, in Docker — the variables from `.env`.

An error in a template tag (a Carbone message with ` Source: "{tag}"`, for example a host outside the allowlist or an invalid image) during generation and preview is `400` with the code `CARBONE_TEMPLATE` and the text “template error: …”; other build failures are still `502` `CARBONE_ERROR`.

`BACKUP_AGENT_URL` and `BACKUP_AGENT_TOKEN` are the backup agent address and the shared token (at least 32 characters). Without the address, backup
management in the admin UI is off: `/api/admin/backups*` respond with `404` and the code `backups_disabled`, and there is no menu item. An address without
a token or a short token is a configuration error at startup. If the agent is unavailable or did not respond within 10 s — `502`
`backup_agent_unavailable` “the backup agent is unavailable”. In Docker `docker-compose.yml` sets both values
(`http://backup-agent:8080` is the agent address inside the stack, only in the internal `backup` network).

## Error format

Errors are returned as `{ error: { code, message, details? } }`. `message` and the field texts in `details` are in the request language: `X-Locale` (one of the interface languages), otherwise `Accept-Language`, otherwise `DEFAULT_LOCALE` (see [“Interface language”](#interface-language)). The error code does not depend on the language. For errors with `code: "VALIDATION"`
`details` comes in two kinds: `[{ path, message }]` when the request schema is validated and `{ fields }`
(field → message) when the report parameters are validated.

During a restore from a backup all routes except `GET /api/health`, `GET /api/maintenance` and
`POST /api/maintenance/retry` respond with `503` and the code `maintenance`, with the phase in `details.phase`. If Redis is unavailable,
the API works as usual: maintenance mode is turned on only by the backup agent, and it always writes the flag to Redis.
