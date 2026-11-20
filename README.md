# Bucketeer

A self-hosted budgeting app built around buckets. TypeScript, Docker, and SQLite, with the server as the source of truth.

Slice 1 supports creating, saving, listing, and reopening named budgets. Accounts, buckets, and money movements come in later slices.

## Run with Docker

```sh
docker compose up --build -d --wait
```

Open <http://localhost:3000>. The named `bucketeer-data` volume keeps budgets across container restarts and replacements. `docker compose down` preserves it; `docker compose down --volumes` deletes it.

The published port binds to localhost by default. To use a private VPN, set `BUCKETEER_BIND` to the server's VPN IP. `BUCKETEER_PORT` changes the host port. This version assumes access through a trusted private network and has no user accounts or authentication.

## CLI

The image includes the `bucketeer` command. Every data command accepts `--json`, which writes one JSON value to stdout. Failures exit nonzero and return `{ "error": { "code": "...", "message": "..." } }` in JSON mode. Without `--json`, errors go to stderr.

```sh
docker compose exec -T bucketeer bucketeer status
docker compose exec -T bucketeer bucketeer budget save --name "Household" --json
docker compose exec -T bucketeer bucketeer budget list --json
docker compose exec -T bucketeer bucketeer budget open <id> --json
docker compose exec -T bucketeer bucketeer budget save --id <id> --name "Family budget" --json
```

Saving without `--id` creates a budget. Saving with `--id` changes its name and preserves its identity and creation time. Names are trimmed and must contain 1 to 120 Unicode code points, with no null characters. Different budgets can share a name; their IDs distinguish them.

Buckets live in groups. Amounts are dollars on the command line and integer cents in JSON; `--position` is 1-based:

```sh
docker compose exec -T bucketeer bucketeer group add --budget <id> --name "Fixed" --json
docker compose exec -T bucketeer bucketeer bucket add --budget <id> --name "Rent" --group <group-id> --type recurring --amount 1650 --json
docker compose exec -T bucketeer bucketeer bucket add --budget <id> --name "Vacation" --new-group "Goals" --type goal --amount 3000 --by 2027-08 --json
docker compose exec -T bucketeer bucketeer bucket list --budget <id> [--archived] --json
docker compose exec -T bucketeer bucketeer bucket move <bucket-id> [--group <group-id>] --position 1 --json
docker compose exec -T bucketeer bucketeer bucket archive <bucket-id> --json
```

`--type` defaults to plain (no amount). A goal month must be this month or later when it is set or changed. Without `--colour`, a bucket gets the least used colour among active buckets. Bucket names stay unique within a budget, archived buckets included. A group can be deleted only when it has no active buckets.

For a remote server, use `--url http://<vpn-address>:3000` or `BUCKETEER_URL`. The CLI always uses HTTP and never accesses the SQLite file directly.

## Development and verification

Requires Node.js 24 or newer and npm. Docker is required for the deployment acceptance check.

```sh
npm ci
npm run check
npm test
npm run acceptance
```

Browser regression tests cover successful saves when the budget-list refresh fails, failed saves and retries, reopening, renaming, mobile layout, the light/dark theme and its saved override, and bundled fonts loading with no external requests. Install Chromium once, then run them:

```sh
npx playwright-core install chromium
npm run test:ui
```

To use an existing Chrome or Chromium executable instead, set `BUCKETEER_BROWSER_PATH` to its full path.

`npm run acceptance` builds an isolated Docker Compose project, saves and updates a budget through the CLI, recreates the container on a non-default port, and verifies the same budget reopens from its SQLite volume. It checks health, errors, and UI assets, then removes only its own containers, volume, and image.

To run without Docker during development:

```sh
npm run build
npm start
# In another terminal:
npm run bucketeer -- status --json
```

Server configuration: `PORT` defaults to `3000`, `HOST` to `0.0.0.0`, and `DATABASE_PATH` to `data/bucketeer.sqlite`. The Docker image sets `DATABASE_PATH=/data/bucketeer.sqlite`.

## Structure

- `src/core/` owns budget rules, IDs, timestamps, and SQLite persistence behind `openBucketeer`, with explicit create and rename operations.
- `src/api.ts` exposes the core through HTTP. `GET /health` queries SQLite and returns 503 when it is unavailable.
- `src/client.ts` is the HTTP client shared by the CLI and UI.
- `src/cli.ts` provides scriptable commands.
- `src/ui/` provides budget selection, saving, renaming, and reopening via a bookmarkable URL. `styles.css` holds the design tokens and light/dark themes; the build bundles the Nunito and Figtree fonts (OFL) from Fontsource into `dist/ui/fonts` with content-hashed names, served as immutable.

HTTP routes: `GET /api/budgets`, `POST /api/budgets` with `{ "name": "Household" }`, and `GET` or `PUT /api/budgets/:id`. PUT accepts `{ "name": "Family budget" }`. POST and PUT reject an `id` in the request body; the server assigns IDs, and PUT takes its ID from the URL. Budget responses contain `id`, `name`, `createdAt`, and `updatedAt`. Timestamps are UTC ISO strings. Future monetary values will use integer cents, with rules in the core.
