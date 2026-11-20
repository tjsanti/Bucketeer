# Bucketeer

A household budgeting app built around buckets: money that comes in is assigned to buckets, and spending draws from them.

## Budget and accounts

**Budget**:
One household's whole set of accounts, buckets and money. It begins in the month it was created.
_Avoid_: File, book

**Account**:
A real place money sits: checking, savings, a credit card or cash. Its balance is its starting balance plus every one of its transactions.
_Avoid_: Wallet (except as an account's name)

**Starting balance**:
What the bank showed for an account when it was added to the budget. It counts toward Ready to assign; a credit card's starting debt reduces it.
_Avoid_: Opening balance, initial balance

## Buckets

**Bucket**:
A named pot of budgeted money with a type: recurring, goal or plain.
_Avoid_: Category (a category is what a transaction is filed under), envelope

**Group**:
An ordered set of buckets, such as Fixed or Everyday.
_Avoid_: Category group, section

**Bucket order**:
The top-to-bottom order of groups and the buckets within them. It is the priority order for rain.

**Recurring bucket**:
A bucket that wants the same monthly amount assigned every month.
_Avoid_: Monthly target bucket, budgeted bucket

**Goal bucket**:
A bucket saving toward a goal amount by a goal month.
_Avoid_: Savings bucket, target

**Plain bucket**:
A bucket with no monthly amount and no goal. Rain never fills it.

**Saved**:
A goal bucket's Available, measured against its goal amount.
_Avoid_: Progress, funded

## Money movement

**Transaction**:
One movement of money into or out of an account, dated today or earlier. It is either money out or money in, never both.
_Avoid_: Entry, posting

**Category**:
What a transaction is filed under: Income, a bucket, a split across buckets, or a transfer.
_Avoid_: Ready to assign (as a category)

**Income**:
The category for money in that feeds Ready to assign. It is always a whole transaction with a positive amount and is never a bucket or a split line.
_Avoid_: Inflow, deposit

**Split**:
A transaction divided into lines across several buckets. Every line has the transaction's sign, and the lines sum exactly to it.

**Transfer**:
A linked pair of transactions moving money between two accounts. It touches no bucket and does not change Ready to assign. Paying a credit card is a transfer.

**Spent**:
The money out of a bucket in a month, counted gross. Money paid back into the bucket never reduces it.
_Avoid_: Activity, outflow

**Assigned**:
The money put into a bucket in a month: from Ready to assign (by hand or by rain) or paid directly into the bucket by a transaction. A bucket does not know where its money came from.
_Avoid_: Budgeted, allocated, received

**Assign / Take**:
Moving money from Ready to assign into a bucket, or from a bucket back to Ready to assign, for a given month.
_Avoid_: Fund, unassign, withdraw

**Available**:
What a bucket holds at the end of a month: carried in + assigned − spent.
_Avoid_: Balance (that is an account's), remaining

**Carried in**:
A bucket's Available from the previous month, positive or negative. It is part of Available and is not shown on its own on the Buckets page.
_Avoid_: Rollover, carryover

**Overspent**:
A bucket whose Available is below zero. It stays overspent, month after month, until money is assigned to it.

## The pool and rain

**Ready to assign**:
The single pool of unassigned money across all months: starting balances plus Income, minus everything assigned from it. It can go negative.
_Avoid_: To be budgeted, unassigned, available to budget

**Rain**:
Filling buckets from Ready to assign for one month, strictly in bucket order, until each bucket's need is met or the money runs out. It is started by hand with Make it rain.
_Avoid_: Auto-assign, distribute

**Need**:
What rain gives a bucket for a month. For a recurring bucket it is its monthly amount minus what's assigned this month. For a goal bucket it is its fixed monthly share minus what's assigned this month. A plain bucket has none.
_Avoid_: Underfunded, shortfall

**Monthly share**:
A goal bucket's portion for a month: what remained to save at the start of the month divided by the months left, including this one.
_Avoid_: Pace, installment

## Time

**Month**:
A calendar month in the server's time zone. The months you can view run from 12 months before the budget began to 12 months after the current month.

**Today**:
The current date in the server's time zone. No transaction may be dated after it.
