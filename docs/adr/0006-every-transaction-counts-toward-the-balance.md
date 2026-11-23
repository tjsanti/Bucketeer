# Every transaction counts toward its account's balance, whatever its date

An account's balance is its starting balance plus all of its transactions, including ones dated before the starting date. The starting balance means "what the bank showed when I started". A charge still pending at that moment is not in that figure, and when it posts it may carry an earlier date. Ignoring or refusing transactions dated before the starting date would leave the balance wrong in exactly that case. The owner only enters transactions the bank had not yet counted, and reconcile catches mistakes.

The limits are: no transaction dated after today; none dated more than 12 months before the month the budget began.
