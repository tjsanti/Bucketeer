# Rain fills strictly top to bottom, with no special case for overspent buckets

Make it rain fills the selected month's buckets from Ready to assign in bucket order. Each bucket receives its full need before the next bucket receives anything. When the money runs out, the bucket where it runs out gets a partial fill and every bucket below it gets nothing. Bucket order is therefore the priority order. Rain does **not** cover overspent buckets first, although the design prototype assumed it would. Bringing an overspent bucket back to zero is the owner's decision, made with the add/take pill.

A bucket's need for a month:
- **Recurring:** the monthly amount − what's assigned that month (net). Carried-in money is ignored, and so is last month's shortfall.
- **Goal:** the monthly share − what's assigned that month. The monthly share is (goal amount − Available at the end of the previous month) ÷ months left including this one, with an overdue goal counting as one month left, rounded up to the cent. It is fixed for the month, so a second rain in the same month adds nothing.
- **Plain:** none. Plain buckets are filled only by hand.

Rain is manual only, never triggered by Income arriving. It shows a preview before you confirm, and it rains only into the current month or a future month. One Undo reverses the whole rain, and is refused if any bucket now holds less Available than the rain gave it.
