import { applyImportPlan } from "./db.js";

export const BACKUP_SCHEMA_VERSION = 1;
const collections = [
  "transactions",
  "categories",
  "budgets",
  "events",
  "mileageTrips",
  "paymentMethods",
  "accounts",
  "receipts",
  "recurringExpenses",
  "savingsGoals"
];

function readU16(view, offset) {
  if (offset + 2 > view.byteLength) throw new Error("Malformed ZIP archive.");
  return view.getUint16(offset, true);
}

function readU32(view, offset) {
  if (offset + 4 > view.byteLength) throw new Error("Malformed ZIP archive.");
  return view.getUint32(offset, true);
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    let value = (crc ^ byte) & 0xff;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    crc = (crc >>> 8) ^ value;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function isSafeArchivePath(path) {
  return Boolean(path) &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").includes("..");
}

export function decodeStoredZip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map();
  let offset = 0;

  while (offset + 4 <= bytes.length) {
    const signature = readU32(view, offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50 || offset + 30 > bytes.length) throw new Error("Malformed ZIP archive.");

    const flags = readU16(view, offset + 6);
    const compression = readU16(view, offset + 8);
    const expectedCRC = readU32(view, offset + 14);
    const size = readU32(view, offset + 18);
    const nameLength = readU16(view, offset + 26);
    const extraLength = readU16(view, offset + 28);
    if (flags !== 0 || compression !== 0) throw new Error("This backup uses an unsupported ZIP compression method.");

    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    const contentStart = nameEnd + extraLength;
    const contentEnd = contentStart + size;
    if (contentEnd > bytes.length) throw new Error("Malformed ZIP archive.");

    const path = new TextDecoder().decode(bytes.slice(nameStart, nameEnd));
    if (!isSafeArchivePath(path)) throw new Error(`Unsafe backup path: ${path}`);
    const content = bytes.slice(contentStart, contentEnd);
    if (crc32(content) !== expectedCRC) throw new Error(`Backup file failed integrity validation: ${path}`);
    entries.set(path, content);
    offset = contentEnd;
  }

  if (!entries.size) throw new Error("The selected file is not a valid Scope backup.");
  return entries;
}

class ByteWriter {
  constructor() { this.parts = []; this.length = 0; }
  push(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.parts.push(bytes);
    this.length += bytes.length;
  }
  u16(value) {
    const buffer = new ArrayBuffer(2);
    new DataView(buffer).setUint16(0, value, true);
    this.push(buffer);
  }
  u32(value) {
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setUint32(0, value >>> 0, true);
    this.push(buffer);
  }
  finish() {
    const output = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }
}

export function encodeStoredZip(entries) {
  const output = new ByteWriter();
  const central = [];
  const encoder = new TextEncoder();

  for (const entry of entries) {
    if (!isSafeArchivePath(entry.path)) throw new Error(`Unsafe backup path: ${entry.path}`);
    const name = encoder.encode(entry.path);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const crc = crc32(data);
    const offset = output.length;

    output.u32(0x04034b50);
    output.u16(20);
    output.u16(0);
    output.u16(0);
    output.u16(0);
    output.u16(0);
    output.u32(crc);
    output.u32(data.length);
    output.u32(data.length);
    output.u16(name.length);
    output.u16(0);
    output.push(name);
    output.push(data);
    central.push({ name, data, crc, offset });
  }

  const centralOffset = output.length;
  for (const entry of central) {
    output.u32(0x02014b50);
    output.u16(20);
    output.u16(20);
    output.u16(0);
    output.u16(0);
    output.u16(0);
    output.u16(0);
    output.u32(entry.crc);
    output.u32(entry.data.length);
    output.u32(entry.data.length);
    output.u16(entry.name.length);
    output.u16(0);
    output.u16(0);
    output.u16(0);
    output.u16(0);
    output.u32(0);
    output.u32(entry.offset);
    output.push(entry.name);
  }
  const centralSize = output.length - centralOffset;
  output.u32(0x06054b50);
  output.u16(0);
  output.u16(0);
  output.u16(central.length);
  output.u16(central.length);
  output.u32(centralSize);
  output.u32(centralOffset);
  output.u16(0);
  return output.finish();
}

export function validateManifest(input) {
  if (!input || typeof input !== "object") throw new Error("manifest.json is not valid JSON.");
  if (input.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`Unsupported Scope backup schema version: ${input.schemaVersion ?? "missing"}.`);
  }
  if (!input.settings || !Number.isInteger(input.settings.taxYear)) {
    throw new Error("The backup has invalid settings or tax year data.");
  }

  const manifest = structuredClone(input);
  for (const name of collections) {
    if (!Array.isArray(manifest[name])) manifest[name] = [];
  }
  if (!manifest.counts || typeof manifest.counts !== "object") manifest.counts = {};
  if (!Array.isArray(manifest.warnings)) manifest.warnings = [];

  const ids = new Set();
  for (const transaction of manifest.transactions) {
    if (!transaction.id || ids.has(transaction.id)) throw new Error("The backup contains missing or duplicate transaction IDs.");
    ids.add(transaction.id);
    if (!["income", "expense"].includes(transaction.type)) throw new Error(`Invalid transaction type for ${transaction.id}.`);
    if (!["active", "deleted"].includes(transaction.status)) throw new Error(`Invalid transaction status for ${transaction.id}.`);
    if (!Number.isFinite(Number(transaction.amount)) || Number(transaction.amount) < 0) throw new Error(`Invalid amount for ${transaction.id}.`);
    if (transaction.receiptImagePath) {
      const expectedPrefix = `receipts/${transaction.id}/`;
      if (!isSafeArchivePath(transaction.receiptImagePath) || !transaction.receiptImagePath.startsWith(expectedPrefix)) {
        throw new Error(`Invalid receipt relationship for ${transaction.id}.`);
      }
    }
  }
  return manifest;
}

function parseManifest(entries) {
  const data = entries.get("manifest.json");
  if (!data) throw new Error("The backup does not contain manifest.json.");
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new Error("manifest.json is not valid JSON.");
  }
  return validateManifest(parsed);
}

export function previewArchive(buffer, currentState = {}) {
  const entries = decodeStoredZip(buffer);
  const manifest = parseManifest(entries);
  const currentIDs = new Set((currentState.transactions || []).map(item => item.id));
  const currentFingerprints = new Set((currentState.transactions || [])
    .filter(item => item.status !== "deleted" && item.transactionFingerprint)
    .map(item => item.transactionFingerprint));

  let duplicateIDs = 0;
  let duplicateFingerprints = 0;
  for (const transaction of manifest.transactions) {
    if (currentIDs.has(transaction.id)) duplicateIDs += 1;
    else if (transaction.status !== "deleted" && transaction.transactionFingerprint && currentFingerprints.has(transaction.transactionFingerprint)) {
      duplicateFingerprints += 1;
    }
  }
  const missingReceipts = manifest.transactions
    .filter(transaction => transaction.receiptImagePath && !entries.has(transaction.receiptImagePath))
    .map(transaction => transaction.receiptImagePath);

  return {
    manifest,
    entries,
    duplicateIDs,
    duplicateFingerprints,
    missingReceipts,
    warnings: [...manifest.warnings, ...missingReceipts.map(path => `Missing receipt file: ${path}`)]
  };
}

export function buildImportPlan(preview, currentState = {}, mode = "merge") {
  if (!["merge", "replace"].includes(mode)) throw new Error("Invalid restore mode.");
  const manifest = preview.manifest;
  const plan = Object.fromEntries(collections.map(name => [name, []]));

  const existingByCollection = Object.fromEntries(collections.map(name => [
    name,
    new Set((currentState[name] || []).map(item => item.id ?? item.eventID))
  ]));
  const existingFingerprints = new Set((currentState.transactions || [])
    .filter(item => item.status !== "deleted" && item.transactionFingerprint)
    .map(item => item.transactionFingerprint));

  for (const name of collections) {
    for (const record of manifest[name]) {
      const id = record.id ?? record.eventID;
      if (mode === "merge" && existingByCollection[name].has(id)) continue;
      if (name === "transactions" && mode === "merge" && record.status !== "deleted" &&
          record.transactionFingerprint && existingFingerprints.has(record.transactionFingerprint)) continue;
      plan[name].push(structuredClone(record));
    }
  }

  plan.settings = [{ key: "profile", ...manifest.settings }];
  plan.imports = [{
    id: crypto.randomUUID(),
    source: "portable-backup",
    importedAt: new Date().toISOString(),
    exportedAt: manifest.exportedAt,
    schemaVersion: manifest.schemaVersion,
    mode
  }];
  return plan;
}

export async function restorePortableBackup(db, preview, currentState, mode) {
  const plan = buildImportPlan(preview, currentState, mode);
  const receiptMetadata = new Map(preview.manifest.receipts.map(receipt => [receipt.relativePath, receipt]));
  const receiptFiles = [];

  for (const [path, bytes] of preview.entries) {
    if (!path.startsWith("receipts/")) continue;
    const metadata = receiptMetadata.get(path);
    const transactionID = path.split("/")[1];
    receiptFiles.push({
      id: metadata?.id || `file:${path}`,
      transactionID: metadata?.transactionID || transactionID,
      fileName: metadata?.fileName || path.split("/").at(-1),
      note: metadata?.note || "",
      addedAt: metadata?.addedAt || new Date().toISOString(),
      relativePath: path,
      byteCount: bytes.length,
      isMissing: false,
      blob: new Blob([bytes])
    });
  }

  await applyImportPlan(db, plan, receiptFiles, mode);
  return {
    insertedTransactions: plan.transactions.length,
    skippedTransactions: preview.manifest.transactions.length - plan.transactions.length,
    restoredReceipts: receiptFiles.length,
    missingReceipts: preview.missingReceipts.length
  };
}

export async function createPortableBackup(state, appVersion = "web-1.0.0") {
  const receiptEntries = [];
  const receipts = [];
  for (const receipt of state.receipts || []) {
    const copy = { ...receipt };
    delete copy.blob;
    receipts.push(copy);
    if (receipt.blob && receipt.relativePath) {
      receiptEntries.push({ path: receipt.relativePath, data: new Uint8Array(await receipt.blob.arrayBuffer()) });
    }
  }

  const settings = (state.settings || []).find(item => item.key === "profile") || {
    businessName: "Scope",
    taxYear: new Date().getFullYear(),
    defaultMileageRate: 0.7,
    dailyReminderEnabled: false,
    weeklyReminderEnabled: false
  };
  const manifest = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    counts: Object.fromEntries(collections.map(name => [name, (state[name] || []).length])),
    settings: {
      businessName: settings.businessName || "Scope",
      taxYear: Number(settings.taxYear),
      defaultMileageRate: Number(settings.defaultMileageRate || 0.7),
      dailyReminderEnabled: Boolean(settings.dailyReminderEnabled),
      weeklyReminderEnabled: Boolean(settings.weeklyReminderEnabled)
    },
    ...Object.fromEntries(collections.map(name => [name, name === "receipts" ? receipts : (state[name] || [])])),
    warnings: []
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  return encodeStoredZip([{ path: "manifest.json", data: manifestBytes }, ...receiptEntries]);
}


export function applyPlanToMemory(currentState, plan, mode = "merge", failAfter = Infinity) {
  const draft = mode === "replace" ? {} : structuredClone(currentState);
  let writes = 0;
  for (const [store, records] of Object.entries(plan)) {
    const existing = new Map((draft[store] || []).map(record => [record.id ?? record.eventID ?? record.key, record]));
    for (const record of records) {
      writes += 1;
      if (writes > failAfter) throw new Error("Simulated transactional failure.");
      existing.set(record.id ?? record.eventID ?? record.key, structuredClone(record));
    }
    draft[store] = [...existing.values()];
  }
  return draft;
}

