import test from "node:test";
import assert from "node:assert/strict";
import {
  DB_VERSION,
  STORE_NAMES,
  applyImportPlan,
  getReceiptBlob,
  migrateReceiptStorage,
  readScopeState
} from "../src/db.js";

const keyPaths = {
  transactions: "id",
  categories: "id",
  budgets: "id",
  events: "id",
  mileageTrips: "id",
  paymentMethods: "id",
  accounts: "id",
  receipts: "id",
  receiptFiles: "storageKey",
  recurringExpenses: "eventID",
  savingsGoals: "id",
  imports: "id",
  settings: "key"
};

function asyncRequest(result) {
  const request = {};
  queueMicrotask(() => {
    request.result = structuredClone(result);
    request.onsuccess?.();
  });
  return request;
}

class MemoryDB {
  constructor(seed = {}) {
    this.stores = new Map(Object.keys(keyPaths).map(name => [name, new Map()]));
    for (const [name, records] of Object.entries(seed)) {
      const keyPath = keyPaths[name];
      for (const record of records) this.stores.get(name).set(record[keyPath], structuredClone(record));
    }
  }

  transaction(storeNames) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const transaction = {
      error: null,
      objectStore: name => {
        if (!names.includes(name)) throw new Error(`Store ${name} is outside this transaction.`);
        const records = this.stores.get(name);
        const keyPath = keyPaths[name];
        return {
          get: key => asyncRequest(records.get(key)),
          getAll: () => asyncRequest([...records.values()]),
          getAllKeys: () => asyncRequest([...records.keys()]),
          put: record => {
            records.set(record[keyPath], structuredClone(record));
            return asyncRequest(record[keyPath]);
          },
          delete: key => {
            records.delete(key);
            return asyncRequest(undefined);
          },
          clear: () => {
            records.clear();
            return asyncRequest(undefined);
          }
        };
      },
      abort: () => {
        transaction.error = new Error("Aborted");
        transaction.onabort?.();
      }
    };
    setTimeout(() => {
      if (!transaction.error) transaction.oncomplete?.();
    }, 0);
    return transaction;
  }
}

test("receipt storage migration moves legacy blobs one at a time and removes orphans", async () => {
  const legacyBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  const db = new MemoryDB({
    receipts: [{ id: "receipt-1", transactionID: "tx-1", relativePath: "receipts/tx-1/a.png", blob: legacyBlob }],
    receiptFiles: [{ storageKey: "orphan", receiptID: "missing", blob: legacyBlob }]
  });
  let yields = 0;

  await migrateReceiptStorage(db, async () => { yields += 1; });
  const state = await readScopeState(db);
  const migrated = state.receipts[0];
  const restoredBlob = await getReceiptBlob(db, migrated);

  assert.equal(DB_VERSION, 2);
  assert.equal(STORE_NAMES.includes("receiptFiles"), false);
  assert.equal("blob" in migrated, false);
  assert.match(migrated.storageKey, /^receipt-file:receipt-1:/);
  assert.equal(restoredBlob.size, 3);
  assert.equal(db.stores.get("receiptFiles").has("orphan"), false);
  assert.ok(yields >= 2);
});

test("backup restore stages receipt files separately from atomic financial metadata", async () => {
  const db = new MemoryDB();
  const receiptBlob = new Blob([new Uint8Array(1024 * 1024)], { type: "image/jpeg" });
  const transaction = { id: "tx-2", type: "expense", amount: 25, status: "active" };
  const receipt = {
    id: "receipt-2",
    transactionID: transaction.id,
    relativePath: "receipts/tx-2/receipt.jpg",
    fileName: "receipt.jpg",
    byteCount: receiptBlob.size,
    blob: receiptBlob
  };
  let yields = 0;

  await applyImportPlan(db, {
    transactions: [transaction],
    receipts: [{ ...receipt, blob: undefined }]
  }, [receipt], "merge", { yieldControl: async () => { yields += 1; } });

  const state = await readScopeState(db);
  assert.equal(state.transactions.length, 1);
  assert.equal(state.receipts.length, 1);
  assert.equal("blob" in state.receipts[0], false);
  assert.match(state.receipts[0].storageKey, /^receipt-file:receipt-2:/);
  assert.equal((await getReceiptBlob(db, state.receipts[0])).size, receiptBlob.size);
  assert.equal(db.stores.get("receiptFiles").size, 1);
  assert.ok(yields >= 1);
});
