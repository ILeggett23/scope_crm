export const DB_NAME = "scope-web";
export const DB_VERSION = 2;
export const STORE_NAMES = [
  "transactions",
  "categories",
  "budgets",
  "events",
  "mileageTrips",
  "paymentMethods",
  "accounts",
  "receipts",
  "recurringExpenses",
  "savingsGoals",
  "imports",
  "settings"
];

const definitions = {
  transactions: { keyPath: "id", indexes: [["status", "status"], ["date", "date"], ["fingerprint", "transactionFingerprint"]] },
  categories: { keyPath: "id" },
  budgets: { keyPath: "id" },
  events: { keyPath: "id" },
  mileageTrips: { keyPath: "id" },
  paymentMethods: { keyPath: "id" },
  accounts: { keyPath: "id" },
  receipts: { keyPath: "id" },
  receiptFiles: { keyPath: "storageKey" },
  recurringExpenses: { keyPath: "eventID" },
  savingsGoals: { keyPath: "id" },
  imports: { keyPath: "id" },
  settings: { keyPath: "key" }
};

export function openScopeDB(indexedDBFactory = globalThis.indexedDB) {
  if (!indexedDBFactory) throw new Error("IndexedDB is unavailable in this browser.");
  return new Promise((resolve, reject) => {
    const request = indexedDBFactory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [name, definition] of Object.entries(definitions)) {
        let store;
        if (!db.objectStoreNames.contains(name)) {
          store = db.createObjectStore(name, { keyPath: definition.keyPath });
        } else {
          store = request.transaction.objectStore(name);
        }
        for (const [indexName, keyPath] of definition.indexes || []) {
          if (!store.indexNames.contains(indexName)) store.createIndex(indexName, keyPath);
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open Scope storage."));
    request.onblocked = () => reject(new Error("Close other Scope tabs and try again."));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Storage request failed."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Storage transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Storage transaction was rolled back."));
  });
}

export async function getAll(db, storeName) {
  return requestResult(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
}

export async function getOne(db, storeName, key) {
  return requestResult(db.transaction(storeName, "readonly").objectStore(storeName).get(key));
}

export async function getAllKeys(db, storeName) {
  return requestResult(db.transaction(storeName, "readonly").objectStore(storeName).getAllKeys());
}

export async function putRecord(db, storeName, record) {
  const transaction = db.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(record);
  await transactionDone(transaction);
  return record;
}

export async function deleteRecord(db, storeName, key) {
  const transaction = db.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).delete(key);
  await transactionDone(transaction);
}

function newReceiptStorageKey(receiptID) {
  return `receipt-file:${receiptID}:${crypto.randomUUID()}`;
}

function receiptMetadata(record, storageKey = record.storageKey || null) {
  const metadata = { ...record, storageKey };
  delete metadata.blob;
  return metadata;
}

export async function getReceiptBlob(db, receipt) {
  if (!receipt) return null;
  if (receipt.blob instanceof Blob) return receipt.blob;
  if (!receipt.storageKey) return null;
  const file = await getOne(db, "receiptFiles", receipt.storageKey);
  return file?.blob instanceof Blob ? file.blob : null;
}

export async function saveReceiptAttachment(db, metadata, blob, previousStorageKey = null) {
  if (!(blob instanceof Blob)) throw new Error("Receipt image data is unavailable.");
  const storageKey = newReceiptStorageKey(metadata.id);
  const transaction = db.transaction(["receiptFiles", "receipts"], "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore("receiptFiles").put({
    storageKey,
    receiptID: metadata.id,
    byteCount: blob.size,
    mimeType: blob.type || "application/octet-stream",
    blob
  });
  const saved = receiptMetadata({ ...metadata, byteCount: blob.size }, storageKey);
  transaction.objectStore("receipts").put(saved);
  await done;
  if (previousStorageKey && previousStorageKey !== storageKey) {
    await deleteRecord(db, "receiptFiles", previousStorageKey).catch(() => {});
  }
  return saved;
}

export async function deleteReceiptAttachment(db, receipt) {
  if (!receipt) return;
  const transaction = db.transaction(["receipts", "receiptFiles"], "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore("receipts").delete(receipt.id);
  if (receipt.storageKey) transaction.objectStore("receiptFiles").delete(receipt.storageKey);
  await done;
}

export async function migrateReceiptStorage(db, yieldControl = () => Promise.resolve()) {
  const receiptIDs = await getAllKeys(db, "receipts");
  for (const receiptID of receiptIDs) {
    const receipt = await getOne(db, "receipts", receiptID);
    if (!(receipt?.blob instanceof Blob)) continue;
    const storageKey = receipt.storageKey || newReceiptStorageKey(receipt.id);
    const transaction = db.transaction(["receiptFiles", "receipts"], "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("receiptFiles").put({
      storageKey,
      receiptID: receipt.id,
      byteCount: receipt.blob.size,
      mimeType: receipt.blob.type || "application/octet-stream",
      blob: receipt.blob
    });
    transaction.objectStore("receipts").put(receiptMetadata(receipt, storageKey));
    await done;
    await yieldControl();
  }

  const receipts = await getAll(db, "receipts");
  const referencedKeys = new Set(receipts.map(receipt => receipt.storageKey).filter(Boolean));
  const fileKeys = await getAllKeys(db, "receiptFiles");
  for (const storageKey of fileKeys) {
    if (referencedKeys.has(storageKey)) continue;
    await deleteRecord(db, "receiptFiles", storageKey);
    await yieldControl();
  }
}

export async function readScopeState(db) {
  const entries = await Promise.all(STORE_NAMES.map(async name => [name, await getAll(db, name)]));
  return Object.fromEntries(entries);
}

export async function applyImportPlan(db, plan, receiptFiles, mode, options = {}) {
  const yieldControl = options.yieldControl || (() => Promise.resolve());
  const currentReceipts = mode === "replace" ? await getAll(db, "receipts") : [];
  if (mode === "merge") {
    for (const file of receiptFiles) {
      const existing = await getOne(db, "receipts", file.id);
      if (existing) currentReceipts.push(existing);
    }
  }
  const oldStorageKeys = new Set(currentReceipts.map(receipt => receipt.storageKey).filter(Boolean));
  const stagedFiles = [];
  const plannedReceipts = new Map((plan.receipts || []).map(receipt => [receipt.id, receiptMetadata(receipt, null)]));
  let transaction = null;

  try {
    for (const file of receiptFiles) {
      const storageKey = newReceiptStorageKey(file.id);
      await putRecord(db, "receiptFiles", {
        storageKey,
        receiptID: file.id,
        byteCount: file.blob.size,
        mimeType: file.blob.type || "application/octet-stream",
        blob: file.blob
      });
      stagedFiles.push(storageKey);
      plannedReceipts.set(file.id, receiptMetadata(file, storageKey));
      await yieldControl();
    }

    const importPlan = { ...plan, receipts: [...plannedReceipts.values()] };
    transaction = db.transaction(STORE_NAMES, "readwrite");
    const done = transactionDone(transaction);

    if (mode === "replace") {
      for (const name of STORE_NAMES) transaction.objectStore(name).clear();
    }

    for (const name of STORE_NAMES) {
      const records = importPlan[name] || [];
      const store = transaction.objectStore(name);
      for (const record of records) store.put(record);
    }
    await done;

    for (const storageKey of oldStorageKeys) {
      if (stagedFiles.includes(storageKey)) continue;
      await deleteRecord(db, "receiptFiles", storageKey).catch(() => {});
      await yieldControl();
    }
  } catch (error) {
    try { transaction?.abort(); } catch {}
    for (const storageKey of stagedFiles) {
      await deleteRecord(db, "receiptFiles", storageKey).catch(() => {});
    }
    throw error;
  }
}

export async function seedScope(db) {
  const [categories, methods, settings] = await Promise.all([
    getAll(db, "categories"),
    getAll(db, "paymentMethods"),
    getAll(db, "settings")
  ]);
  if (categories.length || methods.length || settings.length) return;

  const now = new Date().toISOString();
  const defaults = [
    ["Income", "income", "#168153", true],
    ["Groceries", "cart", "#0d8a55", false],
    ["Dining", "utensils", "#d97706", false],
    ["Gas / Vehicle", "fuel", "#146aff", false],
    ["Housing", "home", "#7c3aed", false],
    ["Utilities", "bolt", "#0891b2", false],
    ["Shopping", "bag", "#db2777", false],
    ["Business Supplies", "briefcase", "#475569", false],
    ["Travel", "plane", "#0284c7", false],
    ["Savings", "trend", "#059669", false],
    ["Miscellaneous", "tag", "#6b7280", false]
  ].map(([name, symbol, colorHex, isIncomeCategory]) => ({
    id: crypto.randomUUID(),
    name,
    symbol,
    colorHex,
    isDefault: true,
    isIncomeCategory,
    createdAt: now
  }));

  const transaction = db.transaction(["categories", "paymentMethods", "settings"], "readwrite");
  for (const category of defaults) transaction.objectStore("categories").put(category);
  transaction.objectStore("paymentMethods").put({ id: crypto.randomUUID(), name: "Checking", symbol: "credit-card", isDefault: true });
  transaction.objectStore("paymentMethods").put({ id: crypto.randomUUID(), name: "Credit Card", symbol: "credit-card", isDefault: false });
  transaction.objectStore("settings").put({ key: "profile", businessName: "Scope", taxYear: new Date().getFullYear(), defaultMileageRate: 0.7 });
  await transactionDone(transaction);
}

export function activeTransactions(transactions) {
  return transactions.filter(transaction => transaction.status !== "deleted");
}
