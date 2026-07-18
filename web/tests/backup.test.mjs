import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeStoredZip,
  createPortableBackupBlob,
  decodeStoredZip,
  previewArchiveAsync,
  previewArchiveFile,
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

test("large portable backups yield while validating receipt bytes", async () => {
  const receiptBytes = new Uint8Array(768 * 1024).fill(7);
  const value = manifest({
    receipts: [{
      id: transaction.receiptID,
      transactionID: transaction.id,
      fileName: "receipt.jpg",
      note: "",
      addedAt: now,
      relativePath: transaction.receiptImagePath,
      byteCount: receiptBytes.length,
      isMissing: false
    }]
  });
  const encoded = encodeStoredZip([
    { path: "manifest.json", data: new TextEncoder().encode(JSON.stringify(value)) },
    { path: transaction.receiptImagePath, data: receiptBytes }
  ]);
  let yields = 0;
  const preview = await previewArchiveAsync(encoded, {}, {
    chunkSize: 32 * 1024,
    yieldControl: async () => { yields += 1; }
  });

  assert.ok(yields > 1);
  assert.equal(preview.missingReceipts.length, 0);
  assert.equal(preview.entries.get(transaction.receiptImagePath).byteLength, receiptBytes.length);
});

test("file-backed backup preview keeps large receipts out of heap byte arrays", async () => {
  const receiptBytes = new Uint8Array(2 * 1024 * 1024).fill(9);
  const encoded = encodeStoredZip([
    { path: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest())) },
    { path: transaction.receiptImagePath, data: receiptBytes }
  ]);
  let yields = 0;
  const preview = await previewArchiveFile(new Blob([encoded]), {}, {
    chunkSize: 64 * 1024,
    yieldControl: async () => { yields += 1; }
  });

  const receiptEntry = preview.entries.get(transaction.receiptImagePath);
  assert.ok(receiptEntry instanceof Blob);
  assert.equal(receiptEntry.size, receiptBytes.length);
  assert.ok(yields > 1);
});

test("streaming portable backup output remains a valid Scope ZIP", async () => {
  const receiptBlob = new Blob([new Uint8Array([5, 6, 7, 8])], { type: "image/jpeg" });
  const state = Object.fromEntries([
    "transactions", "categories", "budgets", "events", "mileageTrips", "paymentMethods",
    "accounts", "receipts", "recurringExpenses", "savingsGoals"
  ].map(name => [name, []]));
  state.transactions = [transaction];
  state.receipts = [{ ...manifest().receipts[0], blob: receiptBlob }];
  state.settings = [{ key: "profile", ...manifest().settings }];

  const backupBlob = await createPortableBackupBlob(state, "test", { yieldControl: async () => {} });
  const preview = await previewArchiveFile(backupBlob, {});
  assert.equal(preview.manifest.transactions.length, 1);
  assert.equal(preview.entries.get(transaction.receiptImagePath).size, 4);
});

test("portable backup parsing can be cancelled when the user leaves Import", async () => {
  const receiptBytes = new Uint8Array(512 * 1024).fill(3);
  const encoded = encodeStoredZip([
    { path: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest())) },
    { path: transaction.receiptImagePath, data: receiptBytes }
  ]);
  let cancelled = false;

  await assert.rejects(previewArchiveAsync(encoded, {}, {
    chunkSize: 32 * 1024,
    yieldControl: async () => { cancelled = true; },
    shouldCancel: () => cancelled
  }), error => error?.name === "AbortError");
});

test("invalid related records are rejected before restore", () => {
  assert.throws(() => previewArchive(archive(manifest({
    categories: [{ name: "Missing stable ID" }]
  })), {}), /invalid category record/i);
  assert.throws(() => previewArchive(archive(manifest({
    budgets: [null]
  })), {}), /invalid budget record/i);
});
