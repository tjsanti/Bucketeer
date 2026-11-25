# Design

Bucketeer's approved visual and interaction design is called **Watercolour**. It describes the whole approved design, some of which isn't built yet, so an unbuilt part is not a defect in itself. The Transactions page and a bucket detail view have no design yet. Terms are defined in [`GLOSSARY.md`](../GLOSSARY.md), and money rules are decided in [`docs/adr/`](adr/).

## Foundation (applies to every page)

- **Type:**
  - Nunito (700/800) for headings, the month title and group names.
  - Figtree (400–700) for body text and all money, using `font-variant-numeric: tabular-nums`.
  - Bundle both fonts with the app (both are OFL). Do not load them from Google Fonts: the app is self-hosted behind a VPN.
- **Tokens:** CSS custom properties. They are in the `:root` and `:root[data-theme="dark"]` blocks of `src/ui/styles.css`.
  - Type scale: 12 / 13 / 15 / 17 / 21 / 26 / 32 / 38.
  - Spacing: steps of 4px.
  - Radii: 8 for chips, 12 for buttons and inputs, 18 for cards, plus pill.
  - Row height: 40px on desktop. Touch targets: at least 44px on phone.
- **Themes:** light and dark are each designed separately; dark is not an inversion. The page follows the system setting, with a manual toggle.
- **Colour roles** (never mix them):
  - Neutrals: sky-tinted greys.
  - Accent: lake teal (`--accent`), for primary actions and focus.
  - Unassigned: violet (`--unassigned`), used only for Ready to assign and Make it rain.
  - Overspent: deep rose-red (`--over`), the only strong warning. Used for overspent buckets and for a negative Ready to assign.
  - Bucket colours: 16 hues (`--b-*`) for identity only. They never carry meaning. No bucket hue may sit near the overspent red.
- **Accessibility:**
  - Text contrast at least 4.5:1; control outlines at least 3:1.
  - Never signal with colour alone.
  - Show negatives with a true minus sign (U+2212).
  - Respect reduced motion.
- **Scrollbars:** thin and themed everywhere (page, dialog body, lists), using `--scroll-thumb` / `--scroll-thumb-hover` with a pill thumb on a transparent track (`scrollbar-width: thin` + `::-webkit-scrollbar`).
- **No usage hints in the UI.** Do not put "type here to…" text on any page. Teach later with a first-run tour or a help page.

## Buckets page: the month

The Buckets page is the month screen. "Buckets page: rows, dialog and reordering" below covers its rows, dialog and reordering.

- **Layout (desktop):**
  - A left sidebar with the brand, the budget picker, navigation (Buckets, Accounts), and accounts with their balances and total.
  - A month header with previous/next arrows and a month-and-year picker.
  - One compact summary strip: Ready to assign (largest, violet, small cents) with **Make it rain** beside it, then Income, Assigned and Spent.
    - Income and Assigned both include money paid directly into buckets (ADR-0003).
    - A negative Ready to assign is in the overspent red with a true minus sign.
    - Rain fills strictly top to bottom (ADR-0005). Make it rain is hidden for past months.
    - Everyday figures never break mid-number (a figure too long for its cell still wraps rather than lose digits). When the strip is under 900px wide (the top bar range, and 1140–1232px windows beside the sidebar) it takes the phone's arrangement: Ready to assign across the top, Income · Assigned · Spent under it; Make it rain drops under the figure if the two don't fit.
  - The bucket table, then Recent activity (read-only, with a "View all transactions" link).
- **Table columns:** Bucket (colour dot and name) · Target or goal · Spent · Add / take · **Available**.
  - Available is the one emphasised column, with a continuous tint.
  - Group rows (such as Fixed, Everyday and Goals) show their totals.
  - There is no static Assigned column. It repeated the vessel text.
- **Three bucket types:**
  1. **Recurring:**
     - A *vessel*: a small bucket icon (18×22) that fills with this month's assigned ÷ target, drawn clamped to 0–100%.
     - While filling it is amber, with the text "**$100.00** of $160.00 per month".
     - When full it is a soft green outline over a pale tint, with the text "$160.00 per month".
  2. **Dated goal:**
     - A slim bar showing the saved balance against the goal amount. The end of the track is the target, so there is no tick.
     - Beside it: the percentage, "of $3,000.00" and the date.
     - Under it, its monthly share worded like a recurring row: "**$100.00** of $300.00 per month" while short, "$300.00 per month" when met, nothing once the goal is reached. On phone it is a third line under "By Aug 2027".
     - Only goals get bars.
  3. **Plain:** no target and no decoration, only the balance.
- **Available:** a bare number with no state words (no Paid, Funded, On track or Saving). The only state shown is **overspent**: a true minus sign, a red figure and a red-tinted cell with a left rule.
- **Add / take pill** (replaces the Assigned column):
  - An 80×24 pill input on every row, empty at rest with a 3:1 outline. On row hover it shows "+ / −".
  - Typing an amount adds from Ready to assign. A leading `-` takes money back to Ready to assign, and is displayed as a true minus.
  - Focusing a pill opens a short panel inside its row: assigned this month (with "of" what the bucket wants each month) and spent. Carried in is not shown.
  - While typing, the panel shows before → after for Available, Ready to assign and Assigned. The row's Available figure and the summary's Ready to assign also preview the result, with a dashed underline.
  - Errors appear as a one-line note floating beside the pill. They never push rows down.
    - "Only $412.50 is ready to assign. You can add up to that."
    - "Gifts has $455.00 available. You can take up to that."
    - Malformed amounts are rejected.
  - Enter applies and keeps focus. Tab applies a valid draft and moves to the next bucket, skipping group rows; an invalid draft is kept, not applied, and does not trap focus. Escape clears.
  - After applying, the pill briefly shows "✓ +20.00" and a snackbar appears: "Added $20.00 to Fuel. Undo". Cmd/Ctrl+Z also undoes. The change is announced to screen readers.
- **No spending entry on this page.** Transactions are entered on the Transactions page and the Account pages.
- **Phone (390px):**
  - Rows show the name, the target or goal line and Available, with a chevron. Rows are 54px, or 74px for goals.
  - Ready to assign and Make it rain appear in the first screen.
  - Tapping a row opens a bottom sheet. Its first tab is **Add / take**:
    - it shows Available and the bucket's figures;
    - an Add | Take toggle replaces the minus key, which phone keypads lack;
    - the amount field is focused, with quick chips such as "Fill 60.00";
    - it previews the result, and its Apply button reads "Add $20.00 to Fuel".
  - The second tab is **Move money**.
  - The sheet has previous/next bucket controls and follows the on-screen keyboard.
  - Behaviour with a native keyboard has only been simulated, not tested on a real phone.

## Narrow desktop (761–1139px)

Beside the 252px sidebar the desktop pages ran out of room below about 1130px without ever scrolling sideways: overlapping register headers, a Category field too narrow for "Groceries", clipped group names, a Ready to assign figure broken across lines.

- **At 1139px and under the sidebar becomes the phone's top bar:** brand, budget picker and theme toggle on one row, the two-tab nav (Buckets | Accounts) under it at full width. The sidebar's account list with balances and total is not shown; accounts stay one click away on the Accounts page. `main` gutters are 24px (16px on phone).
- **Page content stays desktop down to 761px:** the inline register entry, the Add / take pill, the Spent column, centred dialogs and drag reorder. Phone (≤760) is unchanged.
- **Buckets columns in that range:** Bucket 1.15fr · Target or goal 1.25fr · Spent 100 (8px padding on the side facing the names, so 12,345.67 fits) · Add / take 104 (the pill stays 80) · Available 116 (132 beside the sidebar). The page fills the width under the top bar (no 1100px cap there). Below about 820px a long goal share line can end in an ellipsis.
- Safari with always-visible scroll bars (and headless WebKit) evaluates the breakpoints without the 10px scroll bar, so each switch happens about 10px wider there. Accepted.
- Open: tablets in portrait (768–834px) get desktop-sized controls on touch, as before.

## Accounts page

- **Structure:** `/accounts` overview plus one register page per account (prev/next arrows; sidebar accounts link to them).
  - Desktop overview: compact table (Account, Cleared, Uncleared count, Reconciled date, **Balance** in the emphasised column), Total, a "Cash / Owed on cards" line, closed accounts folded away, Recent activity (Account column, "View all transactions").
  - Phone overview: account cards (Balance, Cleared, uncleared count, reconciled date), tap → register with an "Accounts" back control.
  - The overview and account pages have the same month header as the Buckets page. An account's summary shows its end-of-month balance, and its register is filtered to that month.
  - Recent activity shows a transfer once: "Transfer · Checking → Credit card", unsigned amount.
- **Account page:** summary strip (Balance largest, Cleared, Uncleared, Reconcile), then the register: cleared · Date · Payee · Category · Memo · Amount · running Balance, newest first. Columns are shared so the Transactions page can add an Account column.
  - Date column is 140px so every browser's date field shows its whole date and calendar button (Firefox's is the widest).
  - Columns: Date 140 · Payee 1fr · Category 1.2fr · Memo 0.9fr · Amount 128 · Balance 112. Category's field carries a dot and a chevron, so it gets the most of the flexible width; Balance is read-only, with 4px padding on the side facing Amount so 1,234,567.89 still fits.
- **Entry (desktop):** an always-ready inline row at the top, aligned with the columns. Enter saves and readies the next row; Tab moves; Escape cancels; click a row to edit in place. Payee history fills the last category. A −/+ control beside the amount (typing - or + flips it). New rows land at the top of their date, briefly highlighted.
- **Entry (phone):** bottom sheet: amount first (large) with Out | In, payee, category, date, Cleared switch, memo. Primary "Save and add another" (keeps date, account, cleared); secondary "Save and close". Saved feedback and Undo show inside the sheet; the snackbar never covers it. A fixed "New transaction" bar at the bottom.
- **Category picker:** Income, Split, then bucket groups with dots and Available (overspent red), then Transfer accounts (from Checking, Credit card first). Archived buckets are never offered, and Income never appears inside a split (ADR-0002). Filters as you type; arrows + Enter.
- **Split:** sub-lines using the pill input with a live "Left to assign". Total first. Error notes are neutral ink + alert icon (red stays for overspent only), never cover fields, and clear when the lines sum.
- **Transfers:** a linked pair across two accounts, touching no bucket. Editing the memo changes neither balance; amount/date edits update both; delete removes both with one Undo. A compact "Credit card −412.09 → 0.00" preview, no prose.
- **Credit cards:** simple, like Buckets. Negative balance = owed, shown with a true minus in neutral ink (not red). Purchases spend from buckets; paying the card is a transfer. No payment bucket.
- **Money colours:** money in is green with +; outflows neutral with true minus; red only for overspent.
- **Cleared + reconcile:** each row shows an empty circle, a ticked circle or a lock. Reconcile replaces the summary strip while the register stays tickable: Statement balance (starts empty; cards get Owed | In credit), Cleared balance, live Difference. Finish is disabled until the difference is 0.00; "Finish with adjustment" asks an explicit confirm. Where the difference goes is open; it does not go to Ready to assign by default. Finished rows lock behind a "Reconciled <date>" divider; editing a locked row's amount or date needs "Change anyway". Phone: while reconciling, the bottom bar becomes "Difference … · Finish".
- **Accounts:** add (name, type checking/savings/credit card/cash, starting balance, date), edit, close (only at 0.00 balance; reason "Balance must be 0.00"). No bank import and no off-budget accounts yet.
- **Undo:** Cmd/Ctrl+Z is native text undo inside any field; app Undo only outside fields. Snackbar with Undo after save and delete.

### Core requirements from the Accounts design
- Account: name, type, starting balance and date, closed flag (close requires zero balance), order.
- **Starting balance counts as money to assign**: an account's opening balance flows into Ready to assign; a card's negative opening reduces it.
- Transaction: account, date, payee, memo, signed amount (cents), cleared, reconciled; category = bucket | Income | transfer (linked pair) | split (lines summing exactly to the amount).
- Balance, cleared balance, uncleared count per account; payee → last category lookup.
- Reconcile: given a statement balance, finish locks cleared transactions and records the reconciled date; an optional adjustment transaction, whose category is open.
- Undo stays an inverse adjustment (not a snapshot), as for the bucket screen.

## Buckets page: rows, dialog and reordering

- **Buckets page** (`/budgets/:id/buckets`).
  - The title is "Buckets", with the month header, and **Add bucket** (secondary) on the right.
  - Group rows show a count, a ⋯ menu and their totals.
  - Archived buckets fold under the table as "Archived buckets · N". Each row shows the name, "Group · Archived Sep 30" and a Restore button.
- **Row content.**
  - As in "Buckets page: the month". A goal's bar line reads "of $3,000.00 · Aug 2027".
- **The whole row opens Edit.** The name button's hit area covers the row, and its accessible name is "Edit Rent". On phone the row is one tap target with a chevron.
- **Group ⋯ menu:** Add bucket to X · Rename group (inline in the row: Enter saves, Escape cancels) · Delete group (only when it has no active buckets). An empty group stays and shows "No buckets".
- **Bucket dialog** (Add / Edit). It uses the Add account sheet: same head, close button, labels, one footer note above a full-width primary button, and a bottom sheet with a grab handle on phone.
  - The desktop dialog is anchored near the top, so changes in height only move the footer. No state scrolls at 1280×800.
  - The title dot previews the chosen colour.
  - **Name.**
  - **Group:** a styled dropdown, not a native select. It is a button that looks like an input, with a listbox in the budget-picker menu style: groups (the chosen one has a check), a divider, then "New group".
    - Opening or arrowing never changes the choice; only picking does. It also has typeahead.
    - "New group" turns the control into a "New group name" field with a **Choose existing** way back. With no groups yet, the dropdown starts in this mode.
  - **Colour:** a 16-swatch radiogroup in an 8×2 grid (cool row, warm row).
    - Roving tabindex; arrow keys move, and ↑/↓ move by row.
    - Each swatch's accessible name is its hue name.
    - The selected swatch shows a check and an ink ring, and its hue name appears as text beside the label.
    - Swatch edges are at least 3:1 in both themes, and swatches are 44px on phone.
    - The default is the least-used hue among active buckets; ties go to palette order.
  - **Type:** a segmented control, **Recurring · Dated goal · Plain**.
    - Recurring: "Amount per month".
    - Goal: "Goal amount" and "By". By is a month-and-year picker (year stepper + month grid, shared with the month header); months before this month are disabled, and a new goal defaults to 12 months out.
    - Plain folds the row away.
    - Each type keeps its own draft amount when you switch.
  - **Validation:** one note in neutral ink with an alert icon, never red. The bad field gets focus.
  - **Archive** (Edit only, below a divider, like Close account):
    - at 0.00, "Archive Rent";
    - positive: a preview ("Clothing 186.53 → 0.00 · Ready to assign +186.53"), then "**Archive and return $186.53**";
    - overspent: the button is disabled, with "Can’t archive while Available is −18.25".
    - Undo is in the snackbar.
- **Reordering.**
  - **Desktop: drag and drop, always on.**
    - Every bucket row and group row has a grip in a reserved left gutter. It shows on hover and focus-within, and always where there is no hover.
    - While dragging, the source row fades, a lifted copy follows the pointer, an accent drop line shows the target, and the target group's header tints. An empty group's "No buckets" row is a drop target. The page auto-scrolls near the edges, and Escape cancels.
    - A group row carries its buckets with it.
    - The keyboard path is **Alt+↑/↓** on the row's button (`aria-keyshortcuts`). It crosses into the next group at the edges. Focus stays on the moved row, and a live region announces "Fuel moved to Everyday, position 2 of 6".
  - **Phone (≤600px): a Reorder toggle** (an icon button with `aria-pressed`; **Done** ends it). While it is on, rows show a grip, the name and 44px ↑/↓ buttons. Touch-drag works from the grip only, and taps don't open Edit.
  - Every move saves at once, with a snackbar "Moved Fuel up." or "Moved Fuel to Goals." and Undo (the inverse move).
- **Undo** (snackbar) for move, edit, archive and group rename. Undo is an inverse operation against current state and is refused with a reason if the target changed.

### Core requirements from the Bucket design
- Group: name (unique per budget ignoring case), order. Delete only when it has no active buckets.
- Bucket: group, name (unique per budget ignoring case, **archived buckets included**), colour (one of the 16 hue keys), type `recurring {amount > 0 per month}` | `goal {amount > 0, month YYYY-MM}` | `plain`, order within its group, archived date.
  - A goal month is checked against the current month only when it is set or changed, so an overdue goal can still be edited.
- Create can make the bucket's group in the same transaction. A group change appends the bucket to the end of the new group.
- Move bucket (group + index) and move group (index) are atomic and renumber the orders.
- **Archive rule:** refused when Available < 0. When Available > 0, the exact amount returns to Ready to assign in the same transaction. Restore appends the bucket to the end of its group (or, if that group was deleted, to the first group) and never duplicates a group name.
- Palette order and the least-used-hue rule live in a pure shared module, like `money.ts`.
