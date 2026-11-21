# Bucketeer

A self-hosted budgeting app built around buckets. TypeScript, Docker, and SQLite, with the server as the source of truth. A web UI and a scriptable CLI sit on the same HTTP API.

## Status

Early and in active development. Today you can:

- keep several **budgets**, each saved on the server and reopenable by URL;
- track **accounts** (checking, savings, credit card, cash) with a starting balance, closing and reopening them;
- record **income** in each account's register, which fills **Ready to assign** (shown in the sidebar) and the account's balance;
- **transfer** money between accounts, including paying a credit card, with a preview of the other account's balance; a transfer touches no bucket and never Ready to assign;
- see **Recent activity** on the Accounts and Buckets pages, with each transfer shown once;
- **spend** from buckets and get money back into them, on desktop (an inline entry row, editing rows in place) and on a phone (a bottom sheet), with Undo for every add, edit and delete;
- organise **buckets** into **groups**: recurring (a monthly amount), goal (an amount by a month), or plain; reorder them by drag, keyboard, or the phone Reorder mode; archive and restore them.

Splits, assigning money to buckets, and the month view are still to come, so a bucket's Available moves only with the transactions filed to it. Expect the data model to change between releases.

## Run with Docker

```sh
docker compose up --build -d --wait
```

Open <http://localhost:3000>. The named `bucketeer-data` volume keeps your data across container restarts and replacements. `docker compose down` preserves it; `docker compose down --volumes` deletes it. Upgrading to a newer image migrates the database in place on start.

"Today" and "this month" (the current month, future-dated transactions, the default date for new ones) use the server's time zone. Compose mounts the host's `/etc/localtime` read-only. Where that doesn't carry the host's zone, set `TZ` to an IANA zone name, which compose passes through and which wins over the mount:

```sh
TZ=America/Los_Angeles docker compose up --build -d --wait
```

Without either, the container runs in UTC.

> **There are no user accounts or authentication.** Anyone who can reach the port can read and change every budget. The published port binds to `127.0.0.1` by default. To reach it from other devices, put it behind a private network you trust (a VPN such as Tailscale) and set `BUCKETEER_BIND` to the server's VPN IP. Do not expose it to the public internet. `BUCKETEER_PORT` changes the host port.

## CLI

The image includes the `bucketeer` command. Every data command accepts `--json`, which writes one JSON value to stdout. Failures exit nonzero and return `{ "error": { "code": "...", "message": "..." } }` in JSON mode. Without `--json`, errors go to stderr. `bucketeer --help` lists every command.

The examples below use `docker compose exec`; `bucketeer` stands for `docker compose exec -T bucketeer bucketeer`.

```sh
bucketeer status
bucketeer budget save --name "Household" --json
bucketeer budget list --json
bucketeer budget open <id> --json
bucketeer budget save --id <id> --name "Family budget" --json
```

Saving without `--id` creates a budget. Saving with `--id` changes its name and preserves its identity and creation time. Budget names are trimmed and must contain 1 to 120 Unicode code points, with no null characters. Different budgets can share a name; their IDs distinguish them.

Commands that act within a budget take `--budget <id>` or read `BUCKETEER_BUDGET`. Amounts are dollars on the command line and integer cents in JSON.

### Accounts

```sh
bucketeer account add --budget <id> --name "Everyday" --type checking --starting-balance 1200.50 --json
bucketeer account add --budget <id> --name "Visa" --type credit-card --starting-balance -412.09 --json
bucketeer account list --budget <id> --json
bucketeer account edit <account-id> --name "Joint checking" --json
bucketeer account close <account-id> --json
bucketeer account reopen <account-id> --json
```

Types are `checking`, `savings`, `credit-card`, and `cash`; a type is fixed once the account exists. A card's debt is a negative balance. `--date` sets the starting balance date (default: today). Names are unique within a budget, ignoring case. An account can be closed only when its balance is zero.

### Transactions and Ready to assign

```sh
bucketeer tx add --account <account-id> --amount 2000 --income --payee "Acme Payroll" --memo "November" --json
bucketeer tx add --account <account-id> --amount 50 --income --date 2026-11-14 --json
bucketeer tx add --account <account-id> --amount -120 --bucket <bucket-id> --payee "Noodle Bar" --json
bucketeer tx add --account <account-id> --amount 30 --bucket <bucket-id> --payee "Friend" --json
bucketeer tx add --account <checking-id> --amount -412.09 --transfer <card-id> --memo "November statement" --json
bucketeer tx list --account <account-id> --json
bucketeer tx list --account <account-id> --month 2026-10
bucketeer tx edit <transaction-id> --amount 1950 --json
bucketeer tx delete <transaction-id> --json
bucketeer ready --budget <id> --json
```

Every transaction needs exactly one category option: `--income`, `--bucket <id>` or `--transfer <account-id>`. Giving none, or both, is a usage error. Income always has a positive amount and adds to Ready to assign, which is every account's starting balance plus all Income (a card's starting debt reduces it). Ready to assign can be negative.

A bucket takes either sign. Money out counts as the bucket's Spent; money back in (a reimbursement) counts as assigned to that bucket and never reduces Spent. Neither changes Ready to assign. A bucket's `available` is the sum of its transactions and `spent` is its gross money out, whatever their dates. An archived bucket takes no new transactions and can't be chosen in an edit (`bucket_archived`), but a transaction already filed to it keeps it and can still be edited.

A transfer moves money to another account in the same budget (a negative amount) or from it (a positive one), as a linked pair: the other account gets the opposite amount on the same date, with the memo copied. It touches no bucket and doesn't change Ready to assign. Both accounts must be open and different (`invalid_input`, `account_closed`). Editing the amount or date of either side changes both; the payee and memo are each side's own. Deleting either side deletes both. Refiling a transaction to or from a transfer creates or removes the other side.

`--date` defaults to today in the server's time zone. A transaction can't be dated after today or before the first day of the month twelve months before the budget began; a date before the account's starting date is fine and counts toward its balance. An account's balance is its starting balance plus all of its transactions. A closed account takes no new transactions. Payees hold up to 120 characters and memos up to 500, both trimmed.

`tx list` prints the register newest first as `id`, `date`, `payee`, `category` (`Income`, the bucket's name, or `Transfer → Visa` naming the other account), `amount` and the running `balance`, tab-separated; `tx add` and `tx edit` print the same line for their transaction. `--json` gives `{ "transactions": [...] }` with integer cents and a `runningBalance` on each. With `--month YYYY-MM`, it lists only that month's transactions (running balances still count every earlier one) and ends with `Balance at end of YYYY-MM` and the account's balance at the end of that month; `--json` gives `{ "balance": ..., "transactions": [...] }`. A month must lie between twelve months before the budget began and twelve months after the current month.

### Buckets and groups

Buckets live in groups. `--position` is 1-based.

```sh
bucketeer group add --budget <id> --name "Fixed" --json
bucketeer bucket add --budget <id> --name "Rent" --group <group-id> --type recurring --amount 1650 --json
bucketeer bucket add --budget <id> --name "Vacation" --new-group "Goals" --type goal --amount 3000 --by 2027-08 --json
bucketeer bucket list --budget <id> [--archived] --json
bucketeer bucket edit <bucket-id> --amount 1700 --json
bucketeer bucket move <bucket-id> [--group <group-id>] --position 1 --json
bucketeer bucket archive <bucket-id> --json
bucketeer bucket restore <bucket-id> --json
bucketeer group rename <group-id> --name "Bills" --json
bucketeer group move <group-id> --position 1 --json
bucketeer group delete <group-id> --json
```

`--type` defaults to plain (no amount). A goal month must be this month or later when it is set or changed. Without `--colour`, a bucket gets the least used colour among active buckets. Bucket names stay unique within a budget, archived buckets included. A bucket can't be archived while overspent (`bucket_overspent`), or, until assigning exists, while it holds money from a reimbursement (`bucket_has_money`). A group can be deleted only when it has no active buckets.

### Remote servers

For a server on another machine, use `--url http://<vpn-address>:3000` or `BUCKETEER_URL`. The CLI always talks HTTP and never touches the SQLite file directly.

## HTTP API

Everything the UI and CLI do goes through JSON routes under `/api`, plus `GET /health` (queries SQLite; returns 503 when it is unavailable). IDs are assigned by the server and rejected in request bodies. Timestamps are UTC ISO strings, and money is integer cents.

| Resource | Routes |
| --- | --- |
| Budgets | `GET`, `POST /api/budgets`; `GET`, `PUT /api/budgets/:id` |
| Accounts | `GET`, `POST /api/budgets/:id/accounts`; `GET`, `PATCH /api/accounts/:id`; `POST /api/accounts/:id/close`, `/reopen` |
| Transactions | `GET`, `POST /api/accounts/:id/transactions` (the register, newest first, with `runningBalance`); `GET`, `PATCH`, `DELETE /api/transactions/:id` |
| Recent activity | `GET /api/budgets/:id/transactions?limit=n` (1 to 100, default 10): the budget's newest transactions, each transfer once by its money-out side |
| Ready to assign | `GET /api/budgets/:id/ready-to-assign` → `{ "readyToAssign" }` |
| Payees | `GET /api/budgets/:id/payees` → `[{ "payee", "category" }]`, each payee's latest category |
| Groups | `POST /api/budgets/:id/groups`; `PATCH`, `DELETE /api/groups/:id`; `POST /api/groups/:id/move` |
| Buckets | `GET /api/budgets/:id/buckets` (groups and buckets together); `POST /api/budgets/:id/buckets`; `GET`, `PATCH /api/buckets/:id`; `POST /api/buckets/:id/move`, `/archive`, `/restore`, `/revert` |

Errors have the shape `{ "error": { "code", "message" } }` with a matching HTTP status, plus a `field` when one input is to blame.

## Development and verification

Requires Node.js 24 or newer and npm. Docker is required for the deployment acceptance check.

```sh
npm ci
npm run check
npm test
npm run acceptance
```

Browser tests cover the budget picker, accounts, the account register (income, spending and transfer entry, the category picker and its transfer preview, the sign control, editing in place, the phone entry sheet, and Undo for add, edit and delete), Ready to assign, Recent activity, and buckets (add, edit, archive, restore, undo, drag and keyboard reordering), failed saves and failed refreshes, mobile layouts, the light/dark theme and its saved override, and bundled fonts loading with no external requests. Install Chromium once, then run them:

```sh
npx playwright-core install chromium
npm run test:ui
```

To use an existing Chrome or Chromium executable instead, set `BUCKETEER_BROWSER_PATH` to its full path.

`npm run acceptance` builds an isolated Docker Compose project, saves and updates a budget, its accounts, income and buckets through the CLI, recreates the container on a non-default port, and verifies the same budget reopens from its SQLite volume. It also starts the image built from `main` on a separate volume, then upgrades that volume in place with the current build. It checks health, errors, and UI assets, then removes only its own containers, volume, and image.

To run without Docker during development:

```sh
npm run build
npm start
# In another terminal:
npm run bucketeer -- status --json
```

Server configuration: `PORT` defaults to `3000`, `HOST` to `0.0.0.0`, and `DATABASE_PATH` to `data/bucketeer.sqlite`. `TZ` sets the time zone for date rules; it defaults to the machine's zone. The Docker image sets `DATABASE_PATH=/data/bucketeer.sqlite`.

## Structure

- `src/core/` owns budgeting rules (transaction rules in `transactions.ts`, schema history in `migrations.ts`), IDs, timestamps, money, and SQLite persistence behind `openBucketeer`. Rules live here and are never reimplemented in clients; `money.ts` and `colours.ts` are pure and shared with the browser.
- `src/api.ts` exposes the core over HTTP and serves the UI.
- `src/client.ts` is the HTTP client shared by the CLI and UI.
- `src/cli.ts` provides scriptable commands.
- `src/ui/` is the web app, with no framework: the shell and budget picker, the Accounts page and each account's register, the Buckets page, and their dialogs. `styles.css` holds the design tokens and light/dark themes. The build bundles the Nunito and Figtree fonts from Fontsource into `dist/ui/fonts` with content-hashed names, served as immutable.
- `scripts/` holds the asset build and the Docker acceptance check; `test/` holds core, API, CLI, and browser tests.

## Contributing

Bug reports and feature requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for what to include in an issue.

## License

Copyright (c) 2026 Trevor Santiago. Bucketeer is free software under the [GNU Affero General Public License v3.0](LICENSE), or any later version. If you distribute Bucketeer, the license's source requirements apply. If you modify Bucketeer and users interact with it over a network, you must offer those users the corresponding source at no charge.

The bundled Nunito and Figtree fonts are under the SIL Open Font License 1.1; their licence texts ship alongside them in `dist/ui/fonts`.
