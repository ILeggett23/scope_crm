import test from "node:test";
import assert from "node:assert/strict";
import { parseFinancialCSV } from "../src/importer.js";

test("CSV parser never uses running balance as transaction amount", () => {
  const csv = [
    "Date,Description,Debit,Credit,Balance",
    "04/10/2026,Walmart,42.18,,1250.55",
    "04/12/2026,Payroll Deposit,,1200.00,2450.55",
    "04/15/2026,Gas Station,38.44,,2412.11"
  ].join("\n");
  const result = parseFinancialCSV(csv, { accountName: "Checking" });
  assert.deepEqual(result.transactions.map(item => item.amount), [42.18, 1200, 38.44]);
  assert.deepEqual(result.transactions.map(item => item.balanceAfterTransaction), [1250.55, 2450.55, 2412.11]);
  assert.deepEqual(result.transactions.map(item => item.type), ["expense", "income", "expense"]);
  assert.ok(!result.transactions.some(item => item.amount === 1250.55 || item.amount === 2450.55 || item.amount === 2412.11));
});

test("CSV parser ignores statement summary rows", () => {
  const csv = [
    "Date,Description,Amount,Balance",
    "04/01/2026,Beginning Balance,1000.00,1000.00",
    "04/10/2026,Walmart,-42.18,957.82",
    "04/30/2026,Ending Balance,957.82,957.82"
  ].join("\n");
  const result = parseFinancialCSV(csv);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].merchant, "Walmart");
});

