export const DB_NAME = "scope-web";
export const DB_VERSION = 1;
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

export async function readScopeState(db) {
  const entries = await Promise.all(STORE_NAMES.map(async name => [name, await getAll(db, name)]));
  return Object.fromEntries(entries);
}

export async function applyImportPlan(db, plan, receiptFiles, mode) {
  const transaction = db.transaction(STORE_NAMES, "readwrite");
  const done = transactionDone(transaction);

  try {
    if (mode === "replace") {
      for (const name of STORE_NAMES) transaction.objectStore(name).clear();
    }

    for (const name of STORE_NAMES) {
      const records = plan[name] || [];
      const store = transaction.objectStore(name);
      for (const record of records) store.put(record);
    }

    const receiptStore = transaction.objectStore("receipts");
    for (const file of receiptFiles) receiptStore.put(file);
    await done;
  } catch (error) {
    try { transaction.abort(); } catch {}
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

