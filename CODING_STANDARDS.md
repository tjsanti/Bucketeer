# Coding standards

Judgement calls a reviewer applies to a diff; check every rule whose area the diff touches. Terms are defined in [`GLOSSARY.md`](GLOSSARY.md), money rules are decided in [`docs/adr/`](docs/adr/), and the approved design is in [`docs/design.md`](docs/design.md).

## Core and clients

- **Budgeting rules live in core.** Core decides balances, limits, need, monthly share and rain; the API, CLI and UI carry and display the result. A goal's monthly share comes from `monthlyShareOf` (`src/core/rain.ts`) and the UI reads `bucket.monthlyShare` (`src/ui/buckets.ts`). These kinds of UI arithmetic are fine:
  - previewing a draft by adding its delta to server figures (`src/ui/pill.ts`);
  - summing figures already shown, such as the account total (`src/ui/shell.ts`) or split lines (`src/ui/split-lines.ts`);
  - turning two server figures into a drawn proportion (`vessel` in `src/ui/buckets.ts`);
  - backing a shown amount out of a server balance, such as a month's opening balance (`src/ui/register.ts`).
- **A draft check mirrors core with core's own figures and words.** The pill compares a draft with the server's `takeable` and Ready to assign, and shows `addRefusal` or `takeRefusal` (`src/ui/add-take.ts`). Core still refuses the request itself.
- **The UI runs only core's pure modules.** The runtime imports today are `formatMoney` and `parseMoney` (`money.ts`), `addMonths` and `lastDayOf` (`months.ts`), `addRefusal` and `takeRefusal` (`refusals.ts`), `BUCKET_COLOURS` and `leastUsedColour` (`colours.ts`), and `BudgetError` (`types.ts`). Everything else is `import type`. Another helper for formatting, parsing, months or refusal wording is fine; importing a budgeting rule is a finding. A newly imported module must also be pure and in the asset list in `src/api.ts`.
- **Core validates every input at the API boundary.** The API passes request bodies and months to core unchecked, and core reads them with `read*` functions that throw `invalid_input`: `readMonth` (`src/core/months.ts`), `readNewBucket` (`src/core/buckets.ts`). A client guard on data from the server is defensive only, so report one as a reachable bug only with the path bad data takes past core.
- **Money is integer cents.** Amounts stay in cents outside display and input. Display goes through `formatMoney` and typed amounts through `parseMoney` (`src/core/money.ts`). `readDraft` (`src/ui/add-take.ts`) is the one other parser, because it must tell an unfinished draft from an error.
- **"Today" and "this month" are the server's** (ADR-0007). Core reads its injected clock (`now` in `openBucketeer`), and clients default and limit dates with the server's `today` and month range (`ctx.today` in `src/ui/register.ts`). The rule covers dates that are defaulted, stored or checked; showing a timestamp may use the viewer's zone (`archivedDay` in `src/ui/buckets.ts`).
- **Undo is an inverse change against current state.** Undoing a bucket edit, a move, a group rename or a rain is refused with a reason when its target has changed since: `revertBucket` and `undoRain` (`src/core/index.ts`), and the move and rename undos (`src/ui/buckets.ts`).
- **A write that touches several rows is one transaction.** Wrap it in `transaction()`, as `editBucketRow` does (`src/core/index.ts`).
- **A shipped migration is never edited.** A schema change appends to the list in `src/core/migrations.ts`.
- **Modules are deep.** Implementation specifics sit behind a minimal interface: `openBucketeer` (`src/core/index.ts`) hides the SQL, and `openSheet` (`src/ui/sheet.ts`) hides the dialog.
- **An odd line gets a plain fix, not a comment excusing it.** Restructure first: `returnFocusOnClose` (`src/ui/sheet.ts`) got its order by moving a line, with no workaround to explain. A comment is right where the constraint has no plain fix, such as Safari's focus rule. An `eslint-disable` states its reason after `--` (`src/api.ts`).
- **A slice reaches core, API, CLI and UI.** A new action on the budget gets a CLI command with `--json` (`src/cli.ts`). UI conveniences such as payee history and reverting an edit have none.

## Browsers

- **Safari doesn't focus a clicked or tapped button that has no `tabindex`.** Focus falls back to the nearest focusable ancestor, such as a `<dialog>`; three bugs came from this. A control that handles keys, or tracks `focusout`, after a click must place focus explicitly, in one of these ways:
  - the pressed button focuses itself: the budget menu in `src/ui/shell.ts`, `dropdown` in `src/ui/sheet.ts`;
  - opening moves focus inside: the group menu in `src/ui/buckets.ts`;
  - the button or its container has a `tabindex`: `segmented` and `swatches` in `src/ui/sheet.ts`, the picker in `src/ui/month-picker.ts`, whose `focusout` also ignores focus moving to an element around it.

  Each such control needs a browser test that clicks or taps and then uses keys, which WebKit runs: `test/browser/budget.test.ts`, `test/browser/buckets.test.ts`, `test/browser/goal-month.test.ts`.
- **A closing dialog returns focus through `returnFocusOnClose`** (`src/ui/sheet.ts`). It focuses before it removes the dialog, because WebKit on Linux ignores a focus call made after. `openSheet` uses it already; a hand-built dialog calls it, as the phone sheet in `src/ui/register.ts` does.
- **Every change keeps Chromium, WebKit and Firefox passing.** CI runs `npm run test:ui` in all three. What CI can't judge is a test that passes by checking less in one engine: an engine branch in a test is limited to what that engine can't do, and says so (the touch test in `test/browser/buckets.test.ts`).
- **A layout holds at every width it's shown at.** Pages are phone to 760px, desktop under a top bar from 761 to 1139px, and desktop beside the sidebar from 1140px. A change to a register, table or summary column extends the width checks in `test/browser/narrow-desktop.test.ts`. In the summary strip a figure may wrap but never loses digits (`.summary-wrap` in `src/ui/styles.css`).
- **A browser test opens the context before it starts the server**, so cleanup closes the browser first; otherwise the server can wait on the browser's connection forever. Use `openApp` (`test/browser/harness.ts`), or that order by hand (`test/browser/theme.test.ts`).

## UI copy and look

- **Copy uses the glossary's terms and the approved labels.** The bucket types read Recurring, Dated goal and Plain (`src/ui/bucket-dialog.ts`). Money per month reads "per month" (`perMonth` in `src/ui/buckets.ts`).
- **Available is a bare number.** Overspent is the only state shown, so "On track", "Funded", "Paid" and "Saving" stay out of visible copy (`.brow.is-over` in `src/ui/styles.css`).
- **Pages carry no usage hints.** A placeholder holds a format, a resting label or a brief confirmation: "0.00" (`src/ui/sheet.ts`), "+ / −" and "✓ +20.00" (`src/ui/pill.ts`).
- **Negatives use a true minus, U+2212.** `formatMoney` writes it; hand-built signs use the same character (`signed` in `src/ui/add-take.ts`).
- **Each colour has one role.** Violet (`--unassigned`) is for Ready to assign and Make it rain; red (`--over`) is for overspent and a negative Ready to assign; bucket hues (`--b-*`) identify a bucket; errors are neutral ink with an alert icon (`.note`, `.pnote`). Colour is never the only signal: a red figure also has its minus sign. See `src/ui/styles.css`.
- **Colours come from the tokens.** A new colour is a custom property with its own light and dark value (`src/ui/styles.css`); shadows may use a literal.
- **The pill's error floats beside it** and leaves the rows where they are (`.pnote` in `src/ui/styles.css`). A dialog shows one note above its button and focuses the bad field through `FieldError` (`src/ui/sheet.ts`).
