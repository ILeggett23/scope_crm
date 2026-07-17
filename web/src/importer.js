const balanceHeaders = ["balance", "running balance", "available balance", "ending balance"];
const debitHeaders = ["debit", "withdrawal", "withdrawals", "payment", "charge"];
const creditHeaders = ["credit", "deposit", "deposits", "income"];
const amountHeaders = ["amount", "transaction amount"];
const dateHeaders = ["date", "transaction date", "posted date"];
const descriptionHeaders = ["description", "merchant", "name", "memo", "details"];

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function parseCSVRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  row.push(field);
  if (row.some(value => value.trim())) rows.push(row);
  return rows;
}

function indexFor(headers, candidates) {
  return headers.findIndex(header => candidates.includes(normalize(header)));
}

function parseMoney(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const negative = raw.startsWith("-") || (raw.startsWith("(") && raw.endsWith(")"));
  const number = Number(raw.replace(/[$,()+-]/g, ""));
  return Number.isFinite(number) ? (negative ? -number : number) : null;
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

export function transactionFingerprint(transaction) {
  const date = new Date(transaction.date).toISOString().slice(0, 10);
  const merchant = normalize(transaction.merchant).replace(/[^a-z0-9]+/g, " ");
  const cents = Math.round(Number(transaction.amount) * 100);
  const account = normalize(transaction.accountID || transaction.paymentMethodName || "");
  return `${date}|${merchant}|${cents}|${transaction.type}|${account}`;
}

export function parseFinancialCSV(text, options = {}) {
  const rows = parseCSVRows(text);
  if (rows.length < 2) throw new Error("The CSV does not contain transaction rows.");
  const headers = rows[0].map(normalize);
  const dateIndex = indexFor(headers, dateHeaders);
  const descriptionIndex = indexFor(headers, descriptionHeaders);
  const debitIndex = indexFor(headers, debitHeaders);
  const creditIndex = indexFor(headers, creditHeaders);
  const amountIndex = indexFor(headers, amountHeaders);
  const balanceIndex = indexFor(headers, balanceHeaders);

  if (dateIndex < 0 || descriptionIndex < 0 || (debitIndex < 0 && creditIndex < 0 && amountIndex < 0)) {
    throw new Error("Scope could not identify the date, description, and transaction amount columns.");
  }
  if (amountIndex === balanceIndex && amountIndex >= 0) {
    throw new Error("The transaction amount column cannot also be the running balance column.");
  }

  const warnings = [];
  const transactions = [];
  for (const [rowOffset, row] of rows.slice(1).entries()) {
    const date = parseDate(row[dateIndex]);
    const merchant = String(row[descriptionIndex] || "").trim();
    const debit = debitIndex >= 0 ? parseMoney(row[debitIndex]) : null;
    const credit = creditIndex >= 0 ? parseMoney(row[creditIndex]) : null;
    const signedAmount = amountIndex >= 0 ? parseMoney(row[amountIndex]) : null;
    const balance = balanceIndex >= 0 ? parseMoney(row[balanceIndex]) : null;

    let type;
    let amount;
    let confidence = 1;
    if (debit != null && debit !== 0) {
      type = "expense";
      amount = Math.abs(debit);
    } else if (credit != null && credit !== 0) {
      type = "income";
      amount = Math.abs(credit);
    } else if (signedAmount != null && signedAmount !== 0) {
      type = signedAmount < 0 ? "expense" : "income";
      amount = Math.abs(signedAmount);
      confidence = 0.85;
    } else {
      continue;
    }

    const summaryText = normalize(merchant);
    if (/beginning balance|ending balance|total deposits|total withdrawals|account summary|statement balance/.test(summaryText)) continue;
    if (!date || !merchant || !Number.isFinite(amount)) {
      warnings.push(`Row ${rowOffset + 2} needs review.`);
      continue;
    }

    const transaction = {
      id: crypto.randomUUID(),
      amount,
      date: date.toISOString(),
      type,
      merchant,
      isBusiness: false,
      isTaxDeductible: false,
      notes: "Imported locally from CSV.",
      paymentMethodName: options.accountName || "Imported Account",
      categoryNameSnapshot: suggestCategory(merchant),
      categoryID: null,
      eventID: null,
      receiptID: null,
      receiptImagePath: null,
      receiptAttached: false,
      receiptAddedDate: null,
      importSourceHash: options.sourceHash || null,
      importSourceName: options.sourceName || "CSV import",
      accountID: options.accountName || "Imported Account",
      sourceImportID: options.importID || crypto.randomUUID(),
      sourceFileHash: options.sourceHash || null,
      transactionFingerprint: "",
      status: "active",
      deletedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      balanceAfterTransaction: balance,
      confidence
    };
    transaction.transactionFingerprint = transactionFingerprint(transaction);
    transactions.push(transaction);
  }

  if (!transactions.length) throw new Error("No transaction rows were found. Running balances and statement summaries were ignored.");
  return { transactions, warnings, headers, balanceIndex };
}

export function suggestCategory(merchant) {
  const value = normalize(merchant);
  if (/shell|exxon|chevron|bp |gas|fuel/.test(value)) return "Gas / Vehicle";
  if (/walmart|kroger|aldi|grocery|market/.test(value)) return "Groceries";
  if (/netflix|spotify|hulu|subscription/.test(value)) return "Subscriptions";
  if (/payroll|direct deposit|salary/.test(value)) return "Income";
  if (/restaurant|cafe|chick-fil-a|doordash/.test(value)) return "Dining";
  if (/office|staples|supply/.test(value)) return "Business Supplies";
  return "Miscellaneous";
}

export async function sha256Hex(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

