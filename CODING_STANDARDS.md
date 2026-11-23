# Coding standards

These are the judgement calls a reviewer applies to a diff. The compiler, the tests and the build already enforce everything else. Terms come from [`GLOSSARY.md`](GLOSSARY.md); the reasons behind the money rules are in [`docs/adr/`](docs/adr/).

## Where rules live

- **Budgeting rules live in core.** `src/core` decides every budgeting rule: balances, Available, Ready to assign, need, monthly share, rain, refusals and undo. The API, CLI and UI carry and display what core returns, and a client never derives a figure itself. For example, a goal's monthly share is `monthlyShareOf` in `src/core/rain.ts`, and the UI reads `bucket.monthlyShare` (`src/ui/buckets.ts`). Report any arithmetic on money in a client that goes beyond formatting.
- **The UI imports only these from core at runtime:**
  - `money.js` (`formatMoney`, `parseMoney`),
  - `months.js` (month arithmetic such as `addMonths` and `lastDayOf`),
  - `refusals.js` (`addRefusal`, `takeRefusal`: core's wording for a refused add or take),
  - `colours.js` (`BUCKET_COLOURS`, `leastUsedColour`: palette order and the default hue),
  - `types.js` (`BudgetError`, which `parseMoney` throws).

  Imports from `core/index.js` are `import type` only, because it opens SQLite. These modules stay free of Node imports, and each is served to the browser from the asset list in `src/api.ts`. A new runtime import needs a pure module, an entry in that list, and a reason it can't come from the server.
- **Core validates every input at the API boundary.** Each core entry point takes `unknown` and reads it through a `read*` function that throws `BudgetError("invalid_input", message, field)`. Examples are `readMonth` in `src/core/months.ts` and `readNewBucket` in `src/core/buckets.ts`. New input reaches core through such a reader. A client guard on data from the server is only defensive, so don't report a missing one as a reachable bug unless you show how bad data gets in past core.
- **Money is integer cents** everywhere below the display. `parseMoney` and `formatMoney` in `src/core/money.ts` are the only conversions.
- **Undo is an inverse operation, not a snapshot.** It runs against the current state and is refused with a reason when the target has changed since, for example `bucket_changed` or `money_moved` in `src/core/index.ts`. A new undoable action follows the same pattern.
- **Deep modules.** Keep a module's interface small and its details private. `src/core/index.ts` exposes `openBucketeer` and hides the SQL behind it.
- **Slices go core → API → CLI → UI.** Every capability the UI has is also a CLI command with `--json` output, so agents can drive it (`src/cli.ts`, `test/cli*.test.ts`).

## Browsers

- **Safari doesn't focus a clicked or tapped button.** Focus falls back to the nearest focusable ancestor, such as a `<dialog>`. A control that handles keys after a click, or that tracks `focusout`, must focus itself in its click handler, and a `focusout` handler must treat focus moving to an ancestor as staying inside. See `src/ui/month-picker.ts`, `src/ui/sheet.ts` (the group dropdown) and the budget menu in `src/ui/shell.ts`. This quirk has caused three bugs. Every such control needs a browser test that clicks or taps and then uses keys, as in `test/browser/goal-month.test.ts` and `test/browser/buckets.test.ts`, because the suite runs in WebKit.
- **All three engines pass.** `npm run test:ui` runs the browser tests in Chromium, WebKit and Firefox (`scripts/test-ui.ts`). A change is done only when all three pass.

## UI copy and look

The approved design is called **Watercolour**. Its wording rules are:

- **Use the glossary's terms**, such as Ready to assign, Available, Assign / Take, Income, Recurring, Dated goal and Plain. Money for each month reads "per month", as in "$100.00 of $160.00 per month" (`src/ui/buckets.ts`).
- **Use no state words.** Available is a bare number. Words like "On track", "Funded", "Paid" or "Saving" never appear. The one state shown is overspent.
- **Show no usage hints** (such as "type here to…") on any page.
- **Show negatives with a true minus** (U+2212). `formatMoney` does this, so build money text with it.
- **Each colour has one role.** The accent is for actions and focus. Violet (`--unassigned`) is only for Ready to assign and Make it rain. Red (`--over`) is only for overspent figures and a negative Ready to assign. Bucket hues (`--b-*`) only identify a bucket. Validation notes use neutral ink with an alert icon (`.note` in `src/ui/styles.css`), never red. Money coming in is green with a +.
- **Never signal with colour alone.** Text contrast is at least 4.5:1, control outlines at least 3:1, touch targets at least 44px on phone, and reduced motion is respected.
- **Style with the design tokens.** Use the custom properties in `src/ui/styles.css`, with dark values in its single `:root[data-theme="dark"]` block. Fonts are bundled, never loaded from a CDN, because the app runs behind a VPN.
- **Error notes never move the layout.** The pill's refusal floats beside it (`.pnote` in `src/ui/pill.ts`), and a dialog throws `FieldError` so that its one note shows the message and the bad field takes focus (`src/ui/sheet.ts`, `src/ui/bucket-dialog.ts`).
