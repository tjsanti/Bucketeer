# Assignments are a signed ledger, and money paid into a bucket counts as assigned

Every assign, take and rain is stored as its own signed entry (bucket, month, amount, plus a rain id for rain entries). A bucket's assigned figure for a month is not a stored total. Undo is an inverse entry against current balances, and a rain is one group of entries that can be undone together. This is why there is no per-month "budgeted" column to overwrite.

A positive transaction filed to a bucket, such as a friend paying back their share of dinner, also counts as **assigned** to that bucket for its month. It does not reduce Spent, which stays gross. The bucket does not know or care whether money came from Ready to assign or straight from a transaction, so reimbursements count toward a recurring bucket's monthly amount exactly as if they had arrived as Income and then been rained in.

## Consequences

The summary strip counts direct money in on both sides, so that it still adds up. Its **Income** is Income transactions plus money paid directly into buckets, and its **Assigned** is money assigned from Ready to assign plus that same direct money in. The change in Ready to assign over the month still equals Income − Assigned.
