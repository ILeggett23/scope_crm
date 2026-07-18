import { applyImportPlan } from "./db.js?v=20260717-7";

export const BACKUP_SCHEMA_VERSION = 1;
const CRC_CHUNK_SIZE = 256 * 1024;
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

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

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
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function crc32Async(bytes, options = {}) {
  const chunkSize = Math.max(16 * 1024, Number(options.chunkSize) || CRC_CHUNK_SIZE);
  const yieldControl = options.yieldControl || (() => new Promise(resolve => setTimeout(resolve, 0)));
  const shouldCancel = options.shouldCancel || (() => false);
  let crc = 0xffffffff;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    if (shouldCancel()) throw new DOMException("Backup reading was cancelled.", "AbortError");
    const end = Math.min(bytes.length, offset + chunkSize);
    for (let index = offset; index < end; index += 1) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[index]) & 0xff];
    }
    if (end < bytes.length) await yieldControl();
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function crc32Blob(blob, options = {}) {
  const chunkSize = Math.max(16 * 1024, Number(options.chunkSize) || CRC_CHUNK_SIZE);
  const yieldControl = options.yieldControl || (() => new Promise(resolve => setTimeout(resolve, 0)));
  const shouldCancel = options.shouldCancel || (() => false);
  let crc = 0xffffffff;

  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    if (shouldCancel()) throw new DOMException("Backup reading was cancelled.", "AbortError");
    const end = Math.min(blob.size, offset + chunkSize);
    const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    for (let index = 0; index < bytes.length; index += 1) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[index]) & 0xff];
    }
    if (end < blob.size) await yieldControl();
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
    const content = bytes.subarray(contentStart, contentEnd);
    if (crc32(content) !== expectedCRC) throw new Error(`Backup file failed integrity validation: ${path}`);
    entries.set(path, content);
    offset = contentEnd;
  }

  if (!entries.size) throw new Error("The selected file is not a valid Scope backup.");
  return entries;
}

export async function decodeStoredZipAsync(buffer, options = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map();
  let offset = 0;

  while (offset + 4 <= bytes.length) {
    if (options.shouldCancel?.()) throw new DOMException("Backup reading was cancelled.", "AbortError");
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

    const path = new TextDecoder().decode(bytes.subarray(nameStart, nameEnd));
    if (!isSafeArchivePath(path)) throw new Error(`Unsafe backup path: ${path}`);
    const content = bytes.subarray(contentStart, contentEnd);
    if (await crc32Async(content, options) !== expectedCRC) {
      throw new Error(`Backup file failed integrity validation: ${path}`);
    }
    entries.set(path, content);
    offset = contentEnd;
    if (offset < bytes.length) await (options.yieldControl || (() => Promise.resolve()))();
  }

  if (!entries.size) throw new Error("The selected file is not a valid Scope backup.");
  return entries;
}

export async function decodeStoredZipFile(file, options = {}) {
  if (!(file instanceof Blob)) throw new Error("The selected backup file could not be read.");
  const entries = new Map();
  const decoder = new TextDecoder();
  const yieldControl = options.yieldControl || (() => Promise.resolve());
  let offset = 0;

  while (offset + 4 <= file.size) {
    if (options.shouldCancel?.()) throw new DOMException("Backup reading was cancelled.", "AbortError");
    const headerBytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + 30)).arrayBuffer());
    const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
    const signature = readU32(view, 0);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50 || headerBytes.length < 30) throw new Error("Malformed ZIP archive.");

    const flags = readU16(view, 6);
    const compression = readU16(view, 8);
    const expectedCRC = readU32(view, 14);
    const size = readU32(view, 18);
    const nameLength = readU16(view, 26);
    const extraLength = readU16(view, 28);
    if (flags !== 0 || compression !== 0) throw new Error("This backup uses an unsupported ZIP compression method.");

    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    const contentStart = nameEnd + extraLength;
    const contentEnd = contentStart + size;
    if (contentEnd > file.size) throw new Error("Malformed ZIP archive.");

    const nameBytes = new Uint8Array(await file.slice(nameStart, nameEnd).arrayBuffer());
    const path = decoder.decode(nameBytes);
    if (!isSafeArchivePath(path)) throw new Error(`Unsafe backup path: ${path}`);
    const content = file.slice(contentStart, contentEnd);
    if (await crc32Blob(content, options) !== expectedCRC) {
      throw new Error(`Backup file failed integrity validation: ${path}`);
    }
    entries.set(path, content);
    offset = contentEnd;
    if (offset < file.size) await yieldControl();
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

function storedLocalHeader(nameLength, dataLength, crc) {
  const output = new ByteWriter();
  output.u32(0x04034b50);
  output.u16(20);
  output.u16(0);
  output.u16(0);
  output.u16(0);
  output.u16(0);
  output.u32(crc);
  output.u32(dataLength);
  output.u32(dataLength);
  output.u16(nameLength);
  output.u16(0);
  return output.finish();
}

function storedCentralHeader(nameLength, dataLength, crc, offset) {
  const output = new ByteWriter();
  output.u32(0x02014b50);
  output.u16(20);
  output.u16(20);
  output.u16(0);
  output.u16(0);
  output.u16(0);
  output.u16(0);
  output.u32(crc);
  output.u32(dataLength);
  output.u32(dataLength);
  output.u16(nameLength);
  output.u16(0);
  output.u16(0);
  output.u16(0);
  output.u16(0);
  output.u32(0);
  output.u32(offset);
  return output.finish();
}

export async function encodeStoredZipBlob(entries, options = {}) {
  const parts = [];
  const central = [];
  const encoder = new TextEncoder();
  let offset = 0;

  for (const entry of entries) {
    if (!isSafeArchivePath(entry.path)) throw new Error(`Unsafe backup path: ${entry.path}`);
    const name = encoder.encode(entry.path);
    const data = entry.data instanceof Blob ? entry.data : new Blob([entry.data]);
    const crc = await crc32Blob(data, options);
    const header = storedLocalHeader(name.length, data.size, crc);
    parts.push(header, name, data);
    central.push({ name, dataLength: data.size, crc, offset });
    offset += header.length + name.length + data.size;
    await (options.yieldControl || (() => Promise.resolve()))();
  }

  const centralWriter = new ByteWriter();
  for (const entry of central) {
    centralWriter.push(storedCentralHeader(entry.name.length, entry.dataLength, entry.crc, entry.offset));
    centralWriter.push(entry.name);
  }
  const centralBytes = centralWriter.finish();
  const end = new ByteWriter();
  end.u32(0x06054b50);
  end.u16(0);
  end.u16(0);
  end.u16(central.length);
  end.u16(central.length);
  end.u32(centralBytes.length);
  end.u32(offset);
  end.u16(0);
  parts.push(centralBytes, end.finish());
  return new Blob(parts, { type: "application/zip" });
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
    if (!transaction || typeof transaction !== "object") throw new Error("The backup contains an invalid transaction record.");
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

  const requiredID = (record, collection, key = "id") => {
    if (!record || typeof record !== "object" || !record[key]) {
      throw new Error(`The backup contains an invalid ${collection} record.`);
    }
  };
  for (const category of manifest.categories) requiredID(category, "category");
  for (const budget of manifest.budgets) requiredID(budget, "budget");
  for (const event of manifest.events) requiredID(event, "event");
  for (const trip of manifest.mileageTrips) requiredID(trip, "mileage trip");
  for (const method of manifest.paymentMethods) requiredID(method, "payment method");
  for (const account of manifest.accounts) requiredID(account, "account");
  for (const receipt of manifest.receipts) {
    requiredID(receipt, "receipt");
    if (receipt.relativePath && !isSafeArchivePath(receipt.relativePath)) {
      throw new Error(`Invalid receipt path for ${receipt.id}.`);
    }
  }
  for (const recurring of manifest.recurringExpenses) requiredID(recurring, "recurring expense", "eventID");
  for (const goal of manifest.savingsGoals) requiredID(goal, "savings goal");
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

async function parseManifestAsync(entries) {
  const data = entries.get("manifest.json");
  if (!data) throw new Error("The backup does not contain manifest.json.");
  const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("manifest.json is not valid JSON.");
  }
  return validateManifest(parsed);
}

function buildPreview(manifest, entries, currentState = {}) {
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

export function previewArchive(buffer, currentState = {}) {
  const entries = decodeStoredZip(buffer);
  const manifest = parseManifest(entries);
  return buildPreview(manifest, entries, currentState);
}

export async function previewArchiveAsync(buffer, currentState = {}, options = {}) {
  const entries = await decodeStoredZipAsync(buffer, options);
  const manifest = await parseManifestAsync(entries);
  return buildPreview(manifest, entries, currentState);
}

export async function previewArchiveFile(file, currentState = {}, options = {}) {
  const entries = await decodeStoredZipFile(file, options);
  const manifest = await parseManifestAsync(entries);
  return buildPreview(manifest, entries, currentState);
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

export async function restorePortableBackup(db, preview, currentState, mode, options = {}) {
  const plan = buildImportPlan(preview, currentState, mode);
  const receiptMetadata = new Map(preview.manifest.receipts.map(receipt => [receipt.relativePath, receipt]));
  const eligibleTransactionIDs = new Set([
    ...plan.transactions.map(transaction => transaction.id),
    ...(mode === "merge" ? (currentState.transactions || []).map(transaction => transaction.id) : [])
  ]);
  const existingMissingReceiptIDs = new Set((currentState.receipts || [])
    .filter(receipt => !receipt.blob && !receipt.storageKey)
    .map(receipt => receipt.id));
  plan.receipts = plan.receipts.filter(receipt => eligibleTransactionIDs.has(receipt.transactionID));
  const restorableReceiptIDs = new Set([
    ...plan.receipts.map(receipt => receipt.id),
    ...existingMissingReceiptIDs
  ]);
  const receiptFiles = [];

  for (const [path, content] of preview.entries) {
    if (!path.startsWith("receipts/")) continue;
    const metadata = receiptMetadata.get(path);
    const transactionID = path.split("/")[1];
    const receiptID = metadata?.id || `file:${path}`;
    if (!eligibleTransactionIDs.has(metadata?.transactionID || transactionID) || !restorableReceiptIDs.has(receiptID)) continue;
    const blob = content instanceof Blob
      ? content.slice(0, content.size, metadata?.mimeType || "application/octet-stream")
      : new Blob([content], { type: metadata?.mimeType || "application/octet-stream" });
    receiptFiles.push({
      id: receiptID,
      transactionID: metadata?.transactionID || transactionID,
      fileName: metadata?.fileName || path.split("/").at(-1),
      note: metadata?.note || "",
      addedAt: metadata?.addedAt || new Date().toISOString(),
      relativePath: path,
      byteCount: blob.size,
      isMissing: false,
      blob
    });
  }

  await applyImportPlan(db, plan, receiptFiles, mode, options);
  return {
    insertedTransactions: plan.transactions.length,
    skippedTransactions: preview.manifest.transactions.length - plan.transactions.length,
    restoredReceipts: receiptFiles.length,
    missingReceipts: preview.missingReceipts.length
  };
}

function buildPortableManifest(state, appVersion) {
  const receipts = [];
  for (const receipt of state.receipts || []) {
    const copy = { ...receipt };
    delete copy.blob;
    delete copy.storageKey;
    receipts.push(copy);
  }

  const settings = (state.settings || []).find(item => item.key === "profile") || {
    businessName: "Scope",
    taxYear: new Date().getFullYear(),
    defaultMileageRate: 0.7,
    dailyReminderEnabled: false,
    weeklyReminderEnabled: false
  };
  return {
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
}

export async function createPortableBackup(state, appVersion = "web-1.0.0") {
  const receiptEntries = [];
  for (const receipt of state.receipts || []) {
    if (receipt.blob && receipt.relativePath) {
      receiptEntries.push({ path: receipt.relativePath, data: new Uint8Array(await receipt.blob.arrayBuffer()) });
    }
  }
  const manifest = buildPortableManifest(state, appVersion);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  return encodeStoredZip([{ path: "manifest.json", data: manifestBytes }, ...receiptEntries]);
}

export async function createPortableBackupBlob(state, appVersion = "web-1.0.0", options = {}) {
  const manifest = buildPortableManifest(state, appVersion);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const receiptEntries = [];
  for (const receipt of state.receipts || []) {
    const blob = receipt.blob || await options.loadReceiptBlob?.(receipt);
    if (blob instanceof Blob && receipt.relativePath) {
      receiptEntries.push({ path: receipt.relativePath, data: blob });
    }
    await (options.yieldControl || (() => Promise.resolve()))();
  }
  return encodeStoredZipBlob([{ path: "manifest.json", data: manifestBytes }, ...receiptEntries], options);
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
