import type { Account, Bucket, BucketMonthView, Budget, CategoryInput, NewAccountInput, NewBucketInput, Transaction } from "../../src/core/index.js";

/** What `seedRichBudget` made, by the names screenshots and tests refer to. */
export interface RichBudget {
  budget: Budget;
  checking: Account;
  visa: Account;
  /** "YYYY-MM": the server's current month, where every seeded state shows. */
  month: string;
}

/**
 * Seeds, through the API at `url`, a budget that shows every main UI state at once in the server's current month:
 * a checking account and a credit card; two groups; recurring buckets met (Rent) and partly assigned (Groceries);
 * goals partly assigned (Vacation), fully assigned this month (Laptop), already reached (Bike) and with long figures
 * (House deposit); a plain bucket (Fun money); and transactions with income, spending, a split and a transfer, one
 * with a long payee and memo. Plain fetch, with type-only imports, so Node runs it straight from the .ts file.
 */
export async function seedRichBudget(url: string): Promise<RichBudget> {
  async function call<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${url}${path}`, body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Seeding ${path}: HTTP ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }

  const budget = await call<Budget>("/api/budgets", { name: "Household" });
  const api = `/api/budgets/${budget.id}`;
  const { today } = await call<{ today: string }>(`${api}/month-range`);
  const month = today.slice(0, 7);
  const monthOf = (offset: number) => {
    const [year, number] = month.split("-").map(Number) as [number, number];
    const date = new Date(Date.UTC(year, number - 1 + offset, 1));
    return date.toISOString().slice(0, 7);
  };
  const previous = monthOf(-1);
  // Days early in the month, never past today; on the 1st they all land on today.
  const day = (n: number) => `${month}-${String(Math.min(n, Number(today.slice(8)))).padStart(2, "0")}`;

  const account = (input: NewAccountInput) => call<Account>(`${api}/accounts`, input);
  const checking = await account({ name: "Checking", type: "checking", startingBalance: 520_000, startingDate: `${previous}-01` });
  const visa = await account({ name: "Visa", type: "credit-card", startingBalance: -41_209, startingDate: `${previous}-01` });

  const bucket = (input: NewBucketInput) => call<Bucket>(`${api}/buckets`, input);
  const rent = await bucket({ name: "Rent", newGroupName: "Bills", colour: "blue", type: "recurring", amount: 165_000 });
  const groupOf = (made: Bucket) => made.groupId ?? (() => { throw new Error(`Seeding: ${made.name} has no group.`); })();
  const bills = groupOf(rent);
  const groceries = await bucket({ name: "Groceries", groupId: bills, colour: "green", type: "recurring", amount: 60_000 });
  const fun = await bucket({ name: "Fun money", groupId: bills, colour: "rose", type: "plain" });
  const vacation = await bucket({ name: "Vacation", newGroupName: "Goals", colour: "teal", type: "goal", amount: 300_000, goalMonth: monthOf(9) });
  const goals = groupOf(vacation);
  const laptop = await bucket({ name: "Laptop", groupId: goals, colour: "plum", type: "goal", amount: 180_000, goalMonth: monthOf(6) });
  const bike = await bucket({ name: "Bike", groupId: goals, colour: "sun", type: "goal", amount: 60_000, goalMonth: monthOf(5) });
  const house = await bucket({ name: "House deposit", groupId: goals, colour: "cocoa", type: "goal", amount: 250_000_000, goalMonth: monthOf(30) });

  const add = (on: Account, date: string, amount: number, category: CategoryInput, payee = "", memo = "") =>
    call<Transaction>(`/api/accounts/${on.id}/transactions`, { date, amount, category, payee, memo });
  await add(checking, day(1), 241_200, { kind: "income" }, "Northwind Logistics Payroll Direct Deposit", "Paycheque, second half of the month, with the overtime from the warehouse inventory weekend");
  await add(checking, day(1), -165_000, { kind: "bucket", bucketId: rent.id }, "Maple Street Properties");
  await add(checking, day(2), -8_000, { kind: "split", lines: [
    { bucketId: groceries.id, amount: -7_000, memo: "Weekly shop" },
    { bucketId: fun.id, amount: -1_000, memo: "Magazine" },
  ] }, "Superstore");
  await add(visa, day(2), -2_350, { kind: "bucket", bucketId: fun.id }, "Corner Café", "Lunch");
  await add(checking, day(3), -41_209, { kind: "transfer", accountId: visa.id }, "", "Card payment");

  const assign = (id: string, amount: number, at = month) => call<unknown>(`/api/buckets/${id}/assign`, { month: at, amount });
  await assign(bike.id, 60_000, previous);
  await assign(rent.id, 165_000);
  await assign(groceries.id, 30_000);
  await assign(fun.id, 12_000);
  await assign(vacation.id, 10_000);
  await assign(house.id, 234_567);
  const view = await call<BucketMonthView>(`${api}/months/${month}`);
  const laptopShare = view.buckets.find((row) => row.id === laptop.id)?.monthlyShare;
  if (!laptopShare) throw new Error("Seeding: Laptop has no monthly share.");
  await assign(laptop.id, laptopShare);

  return { budget, checking, visa, month };
}
