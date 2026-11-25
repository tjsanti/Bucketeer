import type { createClient } from "../../src/client.js";
import type { Account, Bucket, Budget, CategoryInput, NewBucketInput } from "../../src/core/index.js";

/** What `seedRichBudget` made, by the names screenshots and tests refer to. */
export interface RichBudget {
  budget: Budget;
  checking: Account;
  visa: Account;
  /** "YYYY-MM": the server's current month, where every seeded state shows. */
  month: string;
}

/**
 * Seeds, through the app's HTTP `client`, a budget with the main bucket and transaction states at once in the server's
 * current month: a checking account and a credit card; two groups; recurring buckets met (Rent) and partly assigned
 * (Groceries); goals partly assigned (Vacation), fully assigned this month (Laptop), already reached (Bike) and with
 * long figures (House deposit); a plain bucket (Fun money); and transactions with income, spending, a split and a
 * transfer, one with a long payee and memo. No bucket is overspent.
 */
export async function seedRichBudget(client: ReturnType<typeof createClient>): Promise<RichBudget> {
  const budget = await client.createBudget({ name: "Household" });
  const { first, current: month, last, today } = await client.monthRange(budget.id);
  // Days early in the month, never past today; on the 1st they all land on today.
  const day = (n: number) => `${month}-${String(Math.min(n, Number(today.slice(8)))).padStart(2, "0")}`;

  const checking = await client.createAccount(budget.id, { name: "Checking", type: "checking", startingBalance: 520_000, startingDate: `${first}-01` });
  const visa = await client.createAccount(budget.id, { name: "Visa", type: "credit-card", startingBalance: -41_209, startingDate: `${first}-01` });

  const bucket = (input: NewBucketInput) => client.createBucket(budget.id, input);
  const rent = await bucket({ name: "Rent", newGroupName: "Bills", colour: "blue", type: "recurring", amount: 165_000 });
  const groupOf = (made: Bucket) => made.groupId ?? (() => { throw new Error(`Seeding: ${made.name} has no group.`); })();
  const bills = groupOf(rent);
  const groceries = await bucket({ name: "Groceries", groupId: bills, colour: "green", type: "recurring", amount: 60_000 });
  const fun = await bucket({ name: "Fun money", groupId: bills, colour: "rose", type: "plain" });
  const vacation = await bucket({ name: "Vacation", newGroupName: "Goals", colour: "teal", type: "goal", amount: 300_000, goalMonth: last });
  const goals = groupOf(vacation);
  const laptop = await bucket({ name: "Laptop", groupId: goals, colour: "plum", type: "goal", amount: 180_000, goalMonth: last });
  const bike = await bucket({ name: "Bike", groupId: goals, colour: "sun", type: "goal", amount: 60_000, goalMonth: month });
  const house = await bucket({ name: "House deposit", groupId: goals, colour: "cocoa", type: "goal", amount: 250_000_000, goalMonth: last });

  const add = (on: Account, date: string, amount: number, category: CategoryInput, payee = "", memo = "") =>
    client.addTransaction(on.id, { date, amount, category, payee, memo });
  await add(checking, day(1), 241_200, { kind: "income" }, "Northwind Logistics Payroll Direct Deposit", "Paycheque, second half of the month, with the overtime from the warehouse inventory weekend");
  await add(checking, day(1), -165_000, { kind: "bucket", bucketId: rent.id }, "Maple Street Properties");
  await add(checking, day(2), -8_000, { kind: "split", lines: [
    { bucketId: groceries.id, amount: -7_000, memo: "Weekly shop" },
    { bucketId: fun.id, amount: -1_000, memo: "Magazine" },
  ] }, "Superstore");
  await add(visa, day(2), -2_350, { kind: "bucket", bucketId: fun.id }, "Corner Café", "Lunch");
  await add(checking, day(3), -41_209, { kind: "transfer", accountId: visa.id }, "", "Card payment");

  const assign = (id: string, amount: number, at = month) => client.assign(id, { month: at, amount });
  await assign(bike.id, 60_000, first);
  await assign(rent.id, 165_000);
  await assign(groceries.id, 30_000);
  await assign(fun.id, 12_000);
  await assign(vacation.id, 10_000);
  await assign(house.id, 234_567);
  const view = await client.bucketMonth(budget.id, month);
  const laptopShare = view.buckets.find((row) => row.id === laptop.id)?.monthlyShare;
  if (!laptopShare) throw new Error("Seeding: Laptop has no monthly share.");
  await assign(laptop.id, laptopShare);

  return { budget, checking, visa, month };
}
