# Bucketeer

A self-hosted budgeting app built around buckets. TypeScript, Docker, and SQLite, with the server as the source of truth. A web UI and a scriptable CLI sit on the same HTTP API.

## Status

Early and in active development. Today you can:

- keep several **budgets**, each saved on the server and reopenable by URL;
- track **accounts** (checking, savings, credit card, cash) with a starting balance, closing and reopening them;
- record **income** in each account's register, which fills **Ready to assign** (shown in the Buckets page's summary strip) and the account's balance;
- **transfer** money between accounts, including paying a credit card, with a preview of the other account's balance; a transfer touches no bucket and never Ready to assign;
- see **Recent activity** on the Accounts and Buckets pages, with each transfer shown once;
- **spend** from buckets and get money back into them, on desktop (an inline entry row, editing rows in place) and on a phone (a bottom sheet), with Undo for every add, edit and delete;
- **split** a transaction across several buckets;
- organise **buckets** into **groups**: recurring (a monthly amount), goal (an amount by a month), or plain; reorder them by drag, keyboard, or the phone Reorder mode; archive and restore them;
- move between **months**, with each month's summary of Ready to assign, Income, Assigned and Spent, and each bucket's Assigned, Spent and Available, which carries forward (overspending included);
- **assign** money from Ready to assign to a bucket, or **take** it back, with the add/take pill on desktop or the bucket sheet on a phone, with Undo;
- **make it rain**: fill the month's recurring and goal buckets from Ready to assign in bucket order, after a preview, with one Undo for the whole rain.

Expect the data model to change between releases.

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

## Browser support

The web UI supports the latest Chrome and Edge, Safari on macOS and iOS, and Firefox. Every browser test runs in each of their engines (Chromium, WebKit and Firefox).

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

Types are `checking`, `savings`, `credit-card`, and `cash`; a type is fixed once the account exists. A card's debt is a negative balance. `--date` sets the starting balance date (default: today in the server's time zone). Names are unique within a budget, ignoring case. An account can be closed only when its balance is zero.

### Transactions and Ready to assign

```sh
bucketeer tx add --account <account-id> --amount 2000 --income --payee "Acme Payroll" --memo "November" --json
bucketeer tx add --account <account-id> --amount 50 --income --date 2026-11-14 --json
bucketeer tx add --account <account-id> --amount -120 --bucket <bucket-id> --payee "Noodle Bar" --json
bucketeer tx add --account <account-id> --amount 30 --bucket <bucket-id> --payee "Friend" --json
bucketeer tx add --account <account-id> --amount -80 --line <bucket-id>:-50 --line <bucket-id>:-30 --payee "Superstore" --json
bucketeer tx add --account <checking-id> --amount -412.09 --transfer <card-id> --memo "November statement" --json
bucketeer tx list --account <account-id> --json
bucketeer tx list --account <account-id> --month 2026-10
bucketeer tx edit <transaction-id> --amount 1950 --json
bucketeer tx delete <transaction-id> --json
bucketeer ready --budget <id> --json
```

Every transaction needs exactly one category option: `--income`, `--bucket <id>`, a split given as repeated `--line <bucket-id>:<amount>`, or `--transfer <account-id>`. Giving none, or two kinds, is a usage error. Income always has a positive amount and adds to Ready to assign, which is every account's starting balance plus all Income (a card's starting debt reduces it). Ready to assign can be negative.

A bucket takes either sign. Money out counts as the bucket's Spent; money back in (a reimbursement) counts as assigned to that bucket in the month it is dated and never reduces Spent. Neither changes Ready to assign.

A split files one transaction to two or more buckets. Its lines share the transaction's sign and add up to its amount exactly (`invalid_input` otherwise); each line counts toward its own bucket's Spent (or as assigned, if positive) and Available. Income is never a split line. `tx edit --line …` replaces all of a split's lines, so changing a split's amount means giving its lines again. In `--json` a split's category is `{ "kind": "split", "lines": [{ "bucketId", "amount", "memo" }] }`.

An archived bucket takes no new transactions and can't be chosen in an edit (`bucket_archived`). A transaction already filed to it keeps it, and its payee, memo and a date in the same month can still be edited, but its amount, month and bucket can't change and it can't be deleted until the bucket is restored (`bucket_archived`).

A transfer moves money to another account in the same budget (a negative amount) or from it (a positive one), as a linked pair: the other account gets the opposite amount on the same date, with the memo copied. It touches no bucket and doesn't change Ready to assign. Both accounts must be open and different (`invalid_input`, `account_closed`). Editing the amount or date of either side changes both; the payee and memo are each side's own. Deleting either side deletes both. Refiling a transaction to or from a transfer creates or removes the other side.

`--date` defaults to today in the server's time zone. A transaction can't be dated after today or before the first day of the month twelve months before the budget began; a date before the account's starting date is fine and counts toward its balance. An account's balance is its starting balance plus all of its transactions. A closed account takes no new transactions, and its transactions' amounts can't be edited nor can they be deleted (`account_closed`); reopen it first. Payees hold up to 120 characters and memos up to 500, both trimmed.

`tx list` prints the register newest first as `id`, `date`, `payee`, `category` (`Income`, the bucket's name, `Split (n)`, or `Transfer → Visa` naming the other account), `amount` and the running `balance`, tab-separated; `tx add` and `tx edit` print the same line for their transaction. `--json` gives `{ "transactions": [...] }` with integer cents and a `runningBalance` on each. With `--month YYYY-MM`, it lists only that month's transactions (running balances still count every earlier one) and ends with `Balance at end of YYYY-MM` and the account's balance at the end of that month; `--json` gives `{ "balance": ..., "transactions": [...] }`. A month must lie between twelve months before the budget began and twelve months after the current month.

### Assigning and the month

```sh
bucketeer assign <bucket-id> --amount 1650 --json
bucketeer assign <bucket-id> --amount -50 --month 2026-12 --json
bucketeer month --budget <id> --json
bucketeer month --budget <id> --month 2026-10
```

Money is assigned to a bucket in a month. Every assign (a positive `--amount`) and take (a negative one) is a signed entry in the assignment ledger, and Ready to assign is every starting balance plus all Income minus every ledger entry, in any month, so it is one figure shown alike in every month. Assigning more than Ready to assign is refused (`not_enough_ready`, "Only $412.50 is ready to assign. You can add up to that."), as is assigning to an archived bucket (`bucket_archived`). A take is limited by the lowest Available the bucket has from that month on, since Available carries forward and a take must not leave a later month overspent; taking more is refused (`not_enough_available`, "Gifts has $30.00 available. You can take up to that."). That limit is each bucket's `takeable` in `month --json`. `--month` defaults to the server's current month; any month in the budget's range is allowed.

A bucket's month has `assigned` (ledger entries plus reimbursements dated that month), `spent` (gross money out that month), `carriedIn` (the previous month's Available, negative included, so overspending carries forward) and `available` (`carriedIn + assigned − spent`). A goal's month also has `monthlyShare`: what was still to save at the start of the month ÷ months left including this one, an overdue goal counting as one, rounded up to the cent, and 0 once nothing is left to save; it is `null` for other buckets and archived ones. A bucket's own `available` is its Available in the current month. `month` shows every active bucket plus any archived bucket with a ledger entry or a transaction that month; its groups carry their own `assigned`, `spent` and `available` totals. Its `summary` is the month's strip: `readyToAssign` (the one pool), `income` (Income transactions dated that month plus money paid directly into buckets), `assigned` (ledger entries for the month plus that same direct money) and `spent` (gross money out of buckets), so the month's change in Ready to assign is always `income − assigned`. Its text output is a summary line (`month`, then `Ready to assign`, `Income`, `Assigned` and `Spent`, each followed by its amount), then `group`, `name`, `target`, `assigned`, `spent`, `available` per bucket, tab-separated, where a goal's target ends with its monthly share (`3,000.00 by 2027-08, 300.00/month`) unless it has none (0, or an archived goal); `assign` prints its bucket's line.

### Make it rain

```sh
bucketeer rain --budget <id> --dry-run
bucketeer rain --budget <id> --month 2026-12 --json
bucketeer rain undo <rain-id>
```

Rain fills each active bucket's `need` for the month from Ready to assign, strictly in bucket order (group order, then bucket order): each bucket gets its whole need before the next gets anything, the bucket where the money runs out gets a partial fill, and the rest stay in Ready to assign. Overspent buckets get no special treatment. A recurring bucket needs its monthly amount less what's assigned that month; a goal needs its `monthlyShare` less what's assigned that month; a plain bucket needs nothing. Each bucket's `need` is in `month --json`. Rain goes only into the current month or a later one in the range (`invalid_input` otherwise). `--dry-run` writes nothing and shows exactly what rain would do. The text output is `bucket`, `amount` per fill, then `Total`, then `Rain <rain-id>` when money moved; `--json` gives `{ "rainId", "fills": [{ "bucketId", "amount" }], "total" }`, with no `rainId` when there was nothing to fill. Confirming a rain from a preview (the Buckets page does) is refused with `rain_changed` if the plan is no longer the one previewed. `rain undo` reverses the whole rain, or refuses with `money_moved` if it would take more from a filled bucket than the lowest Available it has from the rain's month on, the same limit as a take.

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

`--type` defaults to plain (no amount). A goal month must be this month or later when it is set or changed. Without `--colour`, a bucket gets the least used colour among active buckets. Bucket names stay unique within a budget, archived buckets included. A bucket can't be archived while overspent in the current month (`bucket_overspent`) or while a later month has money assigned to it (`bucket_has_future`). Archiving a bucket with money left returns it to Ready to assign as a take in the current month, and `returned` in the JSON is that amount; restoring the bucket doesn't put it back. A group can be deleted only when it has no active buckets.

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
| Months | `GET /api/budgets/:id/months/:month` → `{ "summary", "groups", "buckets" }` (one month of buckets, with group totals); `POST /api/buckets/:id/assign` `{ "month", "amount" }` → the bucket's month |
| Payees | `GET /api/budgets/:id/payees` → `[{ "payee", "category" }]`, each payee's latest category |
| Groups | `POST /api/budgets/:id/groups`; `PATCH`, `DELETE /api/groups/:id`; `POST /api/groups/:id/move` |
| Buckets | `GET /api/budgets/:id/buckets` (groups and buckets together); `POST /api/budgets/:id/buckets`; `GET`, `PATCH /api/buckets/:id`; `POST /api/buckets/:id/move`, `/archive`, `/restore`, `/revert` |

Errors have the shape `{ "error": { "code", "message" } }` with a matching HTTP status, plus a `field` when one input is to blame.

## Development and verification

Requires Node.js 24 or newer and npm. Docker is required for the deployment acceptance check.

```sh
npm ci
npm run lint
npm run check
npm test
npm run acceptance
```

Browser tests cover the budget picker, accounts, the account register (income, spending and transfer entry, the category picker and its transfer preview, the sign control, editing in place, the phone entry sheet, and Undo for add, edit and delete), Ready to assign, Recent activity, and buckets (add, edit, archive, restore, undo, drag and keyboard reordering), failed saves and failed refreshes, mobile layouts, the light/dark theme and its saved override, and bundled fonts loading with no external requests. `npm run test:ui` runs every one of them in each supported engine: Chromium, WebKit and Firefox. An engine that isn't installed fails its run rather than being skipped. Install all three once, then run them:

```sh
npx playwright-core install chromium webkit firefox
npm run test:ui
```

On Linux, `npx playwright-core install-deps webkit firefox` adds the system libraries WebKit and Firefox need.

Name engines to run only those, such as `npm run test:ui -- firefox`; other arguments go to `node --test`, so `npm run test:ui -- webkit .test-dist/test/browser/goal-month.test.js` runs one file. Run without the npm script, the tests use the engine in `BUCKETEER_BROWSER` (`chromium`, `webkit` or `firefox`; Chromium by default). Phone tests emulate a phone's viewport and touch in each engine. Firefox has no mobile mode, so its phone still reports a mouse's hover, and Playwright sends touch swipes only to Chromium, so in WebKit and Firefox the touch reorder test checks the `touch-action` that lets the browser scroll and drags with the pointer instead.

To use an existing Chrome or Chromium executable in place of Playwright's Chromium, set `BUCKETEER_BROWSER_PATH` to its full path.

`npm run acceptance` builds an isolated Docker Compose project, saves and updates a budget, its accounts, income and buckets through the CLI, recreates the container on a non-default port, and verifies the same budget reopens from its SQLite volume. It also starts the image built from `main` on a separate volume, then upgrades that volume in place with the current build. It checks health, errors, and UI assets, then removes only its own containers, volume, and image.

`npm run lint` runs ESLint with typescript-eslint's type-aware recommended rules (`eslint.config.js`). Tests and scripts may use untyped JSON; the app code may not.

### Continuous integration and the pre-push hook

GitHub Actions (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request, on Ubuntu with Node.js 24. One job runs `npm ci`, installs the three Playwright engines with their system libraries, then runs `npm run lint`, `npm run check`, `npm test` and `npm run test:ui`. A second job runs `npm run acceptance`, after fetching `main` so the upgrade check can build the image from it. The npm cache and the Playwright engines are cached between runs.

`npm install` (or `npm ci`) also installs a pre-push hook: its `prepare` script points `core.hooksPath` at the committed `.githooks/` directory. Before each push, the hook runs `npm run lint && npm run check && npm test` and stops the push if any fails. It leaves the browser tests and the acceptance check to CI. `git push --no-verify` skips it once; `git config --unset core.hooksPath` removes it until the next `npm install`. The setting lives in the clone's shared Git config, so it covers every worktree of the clone.

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
- `scripts/` holds the asset build, the browser test runner (one run per engine), the screenshot script (`npm run screenshot`) and the Docker acceptance check; `test/` holds core, API, CLI, and browser tests.

## Contributing

Bug reports and feature requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for what to include in an issue.

## License

Copyright (c) 2026 Trevor Santiago. Bucketeer is free software under the [GNU Affero General Public License v3.0](LICENSE), or any later version. If you distribute Bucketeer, the license's source requirements apply. If you modify Bucketeer and users interact with it over a network, you must offer those users the corresponding source at no charge.

The bundled Nunito and Figtree fonts are under the SIL Open Font License 1.1; their licence texts ship alongside them in `dist/ui/fonts`.
