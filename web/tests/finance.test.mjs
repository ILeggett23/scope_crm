import test from "node:test";
import assert from "node:assert/strict";
import { calculateSnapshot } from "../src/finance.js";

const state = {
  transactions: [
    { id: "i", date: "2026-07-02T12:00:00Z", type: "income", amount: 2000, status: "active", categoryID: "income", merchant: "Payroll" },
    { id: "e", date: "2026-07-05T12:00:00Z", type: "expense", amount: 300, status: "active", categoryID: "food", merchant: "Groceries" },
    { id: "d", date: "2026-07-06T12:00:00Z", type: "expense", amount: 9999, status: "deleted", categoryID: "food", merchant: "Deleted" }
  ],
  categories: [{ id: "food", name: "Food", colorHex: "#0d8a55" }, { id: "income", name: "Income" }],
  budgets: [{ id: "b", categoryID: "food", monthlyAmount: 500, alertThreshold: 0.8 }],
  events: [{ id: "rent", name: "Rent", estimatedCost: 900, nextDate: "2026-07-20T12:00:00Z", isActive: true }],
  savingsGoals: [],
  accounts: []
};

test("calculations exclude soft-deleted transactions", () => {
  const snapshot = calculateSnapshot(state, new Date("2026-07-10T12:00:00Z"));
  assert.equal(snapshot.expenses, 300);
  assert.equal(snapshot.budgetRows[0].remaining, 200);
});

