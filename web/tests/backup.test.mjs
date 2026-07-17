import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeStoredZip,
  decodeStoredZip,
  previewArchive,
  buildImportPlan,
  validateManifest,
  applyPlanToMemory
} from "../src/backup.js";

const now = "2026-07-17T12:00:00Z";
const transaction = {
  id: "11111111-1111-4111-8111-111111111111",
  amount: 42.18,
  date: now,
  type: "expense",
  merchant: "Walmart",
  isBusiness: false,
  isTaxDeductible: false,
  notes: "",
  paymentMethodName: "Checking",
  categoryNameSnapshot: "Groceries",
  categoryID: null,
  eventID: null,
  receiptID: "22222222-2222-4222-8222-222222222222",
  receiptImagePath: "receipts/11111111-1111-4111-8111-111111111111/receipt.jpg",
  receiptAttached: true,
  receiptAddedDate: now,
  importSourceHash: null,
  importSourceName: null,
  accountID: "Checking",
  sourceImportID: null,
  sourceFileHash: null,
  transactionFingerprint: "2026-07-17|walmart|4218|expense|checking",
  status: "active",
  deletedAt: null,
  createdAt: now,
  updatedAt: now
};

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    appVersion: "test",
    exportedAt: now,
    counts: { transactions: 1, receipts: 1 },
    settings: { businessName: "Scope", taxYear: 2026, defaultMileageRate: 0.7, dailyReminderEnabled: false, weeklyReminderEnabled: false },
    transactions: [transaction],
    categories: [],
    budgets: [],
    events: [],
    mileageTrips: [],
    paymentMethods: [],
    accounts: [],
    receipts: [{
      id: transaction.receiptID,
      transactionID: transaction.id,
      fileName: "receipt.jpg",
      note: "",
      addedAt: now,
      relativePath: transaction.receiptImagePath,
      byteCount: 4,
      isMissing: false
    }],
    recurringExpenses: [],
    savingsGoals: [],
    warnings: [],
    ...overrides
  };
}

function archive(value = manifest(), includeReceipt = true) {
  const entries = [{ path: "manifest.json", data: new TextEncoder().encode(JSON.stringify(value)) }];
  if (includeReceipt) entries.push({ path: transaction.receiptImagePath, data: new Uint8Array([1, 2, 3, 4]) });
  return encodeStoredZip(entries);
}

test("portable ZIP round trip preserves manifest and receipt bytes", () => {
  const encoded = archive();
  const entries = decodeStoredZip(encoded);
  assert.deepEqual([...entries.get(transaction.receiptImagePath)], [1, 2, 3, 4]);
  const preview = previewArchive(encoded, {});
  assert.equal(preview.manifest.settings.taxYear, 2026);
  assert.equal(preview.missingReceipts.length, 0);
});

test("preview reports active duplicate fingerprints", () => {
  const current = { transactions: [{ ...transaction, id: "different-id" }] };
  const preview = previewArchive(archive(), current);
  assert.equal(preview.duplicateFingerprints, 1);
  assert.equal(buildImportPlan(preview, current, "merge").transactions.length, 0);
});

test("deleted fingerprints do not block reimport", () => {
  const current = { transactions: [{ ...transaction, id: "deleted-id", status: "deleted" }] };
  const preview = previewArchive(archive(), current);
  assert.equal(preview.duplicateFingerprints, 0);
  assert.equal(buildImportPlan(preview, current, "merge").transactions.length, 1);
});

test("missing receipt is clearly surfaced before restore", () => {
  const preview = previewArchive(archive(manifest(), false), {});
  assert.deepEqual(preview.missingReceipts, [transaction.receiptImagePath]);
  assert.match(preview.warnings[0], /Missing receipt file/);
});

test("schema validation rejects unsupported versions and unsafe relationships", () => {
  assert.throws(() => validateManifest(manifest({ schemaVersion: 2 })), /Unsupported/);
  assert.throws(() => validateManifest(manifest({
    transactions: [{ ...transaction, receiptImagePath: "../private.jpg" }]
  })), /Invalid receipt relationship/);
});

test("failed in-memory import leaves original state unchanged", () => {
  const current = { transactions: [{ id: "existing", status: "active" }] };
  const before = structuredClone(current);
  const plan = { transactions: [{ id: "new-1" }, { id: "new-2" }] };
  assert.throws(() => applyPlanToMemory(current, plan, "merge", 1), /Simulated/);
  assert.deepEqual(current, before);
});

