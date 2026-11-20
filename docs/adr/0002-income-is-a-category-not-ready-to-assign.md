# Income is a category; Ready to assign is not

The locked Accounts design put "Ready to assign" in the category picker. Instead, the picker offers **Income**. Income is not a bucket, and an Income transaction is the only kind that adds to Ready to assign. An Income transaction always has a positive amount and covers the whole transaction: it is never a split line. A wrong paycheck is fixed by editing or deleting it, not with a negative Income.

Ready to assign therefore changes in only three ways: Income comes in, money is assigned to a bucket, or money is taken back from a bucket. A starting balance is the one exception: it still counts as money to assign (owner rule, 2026-11-15).

Where a reconcile adjustment goes (formerly "to Ready to assign") is left open until the reconcile slice.
