import {
  openScopeDB,
  seedScope,
  readScopeState,
  putRecord,
  deleteRecord,
  applyImportPlan,
  activeTransactions
} from "./db.js";
import { calculateSnapshot, money } from "./finance.js";
import {
  createPortableBackup,
  previewArchive,
  restorePortableBackup
} from "./backup.js";
import {
  parseFinancialCSV,
  sha256Hex,
  transactionFingerprint
} from "./importer.js";
import { debounce, yieldToBrowser } from "./ui.js";

const content = document.querySelector("#app-content");
const main = document.querySelector(".main");
const topbar = document.querySelector(".topbar");
const title = document.querySelector("#view-title");
const eyebrow = document.querySelector("#view-eyebrow");
const modalRoot = document.querySelector("#modal-root");
const toast = document.querySelector("#toast");
const imageViewer = document.querySelector("#image-viewer");
const viewerImage = document.querySelector("#viewer-image");

let db;
let state;
let currentView = "dashboard";
let currentCSVPreview = null;
let currentBackupPreview = null;
let receiptURLCache = new Map();
let toastTimer;
let modalReturnFocus = null;
let imageViewerReturnFocus = null;
let overlayScrollY = 0;

const viewMeta = {
  dashboard: ["Scope", "Financial overview"],
  transactions: ["Transactions", "Income and spending"],
  budget: ["Budget", "Monthly control"],
  events: ["Events", "Bills and recurring plans"],
  mileage: ["Mileage", "Business trip deductions"],
  reports: ["Reports", "Clear financial summaries"],
  import: ["Import", "Local financial documents"],
  settings: ["Settings", "Profile, categories, and backup"]
};

const legacyIconNames = {
  "◎": "scope",
  "≡": "transactions",
  "◔": "budget",
  "□": "events",
  "↗": "route",
  "▥": "reports",
  "◇": "target",
  "!": "alert-circle"
};

function icon(name, className = "") {
  const iconName = legacyIconNames[name] || name;
  return `<svg class="icon ${className}" aria-hidden="true"><use href="assets/icons.svg#icon-${iconName}"></use></svg>`;
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]);
}

function formatDate(value, options = { month: "short", day: "numeric", year: "numeric" }) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown date" : date.toLocaleDateString(undefined, options);
}

function dateInput(value = new Date()) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function syncOverlayState() {
  const hasOverlay = Boolean(modalRoot.firstElementChild)
    || !imageViewer.hidden;
  const wasOpen = document.body.classList.contains("overlay-open");
  if (hasOverlay && !wasOpen) {
    const isMobile = window.innerWidth <= 720;
    overlayScrollY = isMobile ? main.scrollTop : window.scrollY;
    document.body.style.top = isMobile ? "0" : `-${overlayScrollY}px`;
    document.body.classList.add("overlay-open");
  } else if (!hasOverlay && wasOpen) {
    const isMobile = window.innerWidth <= 720;
    document.body.classList.remove("overlay-open");
    document.body.style.removeProperty("top");
    if (isMobile) main.scrollTop = overlayScrollY;
    else window.scrollTo(0, overlayScrollY);
  }
}

function syncTopbarScrollState() {
  const scrollTop = window.innerWidth <= 720 ? main.scrollTop : window.scrollY;
  topbar.classList.toggle("is-scrolled", scrollTop > 8);
}

function trapFocus(event, container) {
  const focusable = [...container.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
    .filter(element => element.getAttribute("aria-hidden") !== "true");
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function revokeObjectURLs() {
  for (const url of receiptURLCache.values()) URL.revokeObjectURL(url);
  receiptURLCache.clear();
}

function receiptURL(receiptID) {
  const cachedURL = receiptURLCache.get(receiptID);
  if (cachedURL) return cachedURL;
  const receipt = (state.receipts || []).find(item => item.id === receiptID);
  if (!receipt?.blob) return null;
  const url = URL.createObjectURL(receipt.blob);
  receiptURLCache.set(receiptID, url);
  return url;
}

async function reload(render = true) {
  revokeObjectURLs();
  state = await readScopeState(db);
  if (render) renderView();
}

function emptyState(symbol, heading, message) {
  return `<div class="empty-state"><span class="empty-symbol">${icon(symbol)}</span><strong>${escapeHTML(heading)}</strong><span>${escapeHTML(message)}</span></div>`;
}

function categoryName(id, fallback = "Uncategorized") {
  return state.categories.find(category => category.id === id)?.name || fallback;
}

function categoryOptions(selectedID = "", includeIncome = true) {
  return state.categories
    .filter(category => includeIncome || !category.isIncomeCategory)
    .map(category => `<option value="${escapeHTML(category.id)}" ${category.id === selectedID ? "selected" : ""}>${escapeHTML(category.name)}</option>`)
    .join("");
}

function paymentOptions(selected = "") {
  return state.paymentMethods
    .map(method => `<option value="${escapeHTML(method.name)}" ${method.name === selected ? "selected" : ""}>${escapeHTML(method.name)}</option>`)
    .join("");
}

function setView(view) {
  currentView = view;
  document.querySelectorAll("[data-view]").forEach(button => {
    const isActive = button.dataset.view === view;
    button.classList.toggle("is-active", isActive);
    if (isActive) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const moreButton = document.querySelector("#mobile-more-button");
  const isMoreView = ["mileage", "reports", "import", "settings"].includes(view);
  moreButton.classList.toggle("is-active", isMoreView);
  if (isMoreView) moreButton.setAttribute("aria-current", "page");
  else moreButton.removeAttribute("aria-current");
  const [heading, detail] = viewMeta[view] || viewMeta.dashboard;
  title.textContent = heading;
  eyebrow.textContent = detail;
  renderView();
  if (window.innerWidth <= 720) main.scrollTo({ top: 0, behavior: "smooth" });
  else window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderView() {
  const renderer = {
    dashboard: renderDashboard,
    transactions: renderTransactions,
    budget: renderBudget,
    events: renderEvents,
    mileage: renderMileage,
    reports: renderReports,
    import: renderImport,
    settings: renderSettings
  }[currentView] || renderDashboard;
  content.innerHTML = renderer();
  bindViewEvents();
}

function renderDashboard() {
  const snapshot = calculateSnapshot(state);
  const budgetRows = snapshot.budgetRows.slice(0, 5);
  const profile = state.settings.find(item => item.key === "profile") || {};
  const personalSpend = snapshot.monthly.filter(item => item.type === "expense" && !item.isBusiness).reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const businessSpend = snapshot.monthly.filter(item => item.type === "expense" && item.isBusiness).reduce((sum, item) => sum + Number(item.amount || 0), 0);
  return `
    <div class="dashboard-intro">
      <p>Good ${new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening"}</p>
      <h2>${escapeHTML(profile.businessName || "Scope")}</h2>
      <span>Personal and business money, clearly organized.</span>
    </div>
    <div class="dashboard-grid">
      <article class="card hero-card span-12">
        <div class="hero-heading">
          <div>
            <p class="metric-label">Net cash flow</p>
            <p class="hero-value ${snapshot.net >= 0 ? "positive" : "negative"}">${money(snapshot.net)}</p>
            <p class="metric-foot">This month</p>
          </div>
          <span class="hero-icon ${snapshot.net >= 0 ? "positive" : "caution"}">${icon(snapshot.net >= 0 ? "trending-up" : "alert-circle")}</span>
        </div>
        <div class="metric-pills">
          <div class="metric-pill income"><span>Income</span><strong>${money(snapshot.income)}</strong></div>
          <div class="metric-pill expense"><span>Expenses</span><strong>${money(snapshot.expenses)}</strong></div>
        </div>
        <div class="compact-metrics">
          <div><span>Flexible after bills</span><strong>${money(snapshot.flexibleMoneyAfterBills)}</strong></div>
          <div><span>Upcoming bills</span><strong>${money(snapshot.upcomingBillsTotal)}</strong></div>
        </div>
      </article>

      <article class="card span-6 scope-summary-card">
        <div class="card-header compact"><div class="section-title"><span class="section-icon personal">${icon("home")}</span><div><h2>Personal</h2><p>Everyday spending this month</p></div></div></div>
        <p class="metric-value">${money(personalSpend)}</p>
        <p class="metric-foot">${snapshot.monthly.filter(item => item.type === "expense" && !item.isBusiness).length} personal expenses</p>
      </article>
      <article class="card span-6 scope-summary-card">
        <div class="card-header compact"><div class="section-title"><span class="section-icon business">${icon("briefcase")}</span><div><h2>Business</h2><p>Business spending this month</p></div></div></div>
        <p class="metric-value">${money(businessSpend)}</p>
        <p class="metric-foot">${snapshot.monthly.filter(item => item.type === "expense" && item.isBusiness).length} business expenses</p>
      </article>

      <article class="card span-7 dashboard-budget-card">
        <div class="card-header">
          <div class="section-title"><span class="section-icon">${icon("budget")}</span><div><h2>Budget progress</h2><p>Monthly category limits</p></div></div>
          <button class="secondary-button" data-view-jump="budget">Manage</button>
        </div>
        ${budgetRows.length ? budgetRows.map(budget => {
          const percent = Math.max(0, budget.percent * 100);
          return `<div class="progress-row">
            <div class="progress-label"><strong>${escapeHTML(budget.categoryName)}</strong><span>${money(budget.spent)} of ${money(budget.monthlyAmount)}</span></div>
            <div class="progress-track"><div class="progress-fill ${percent > 100 ? "over" : percent >= 80 ? "warning" : ""}" style="width:${Math.min(100, percent)}%"></div></div>
          </div>`;
        }).join("") : emptyState("◔", "No budgets yet", "Add a monthly category budget to see progress.")}
      </article>

      <article class="card span-5">
        <div class="card-header"><div class="section-title"><span class="section-icon green">${icon("budget")}</span><div><h2>Where money is going</h2><p>Top categories this month</p></div></div></div>
        ${snapshot.topCategories.length ? snapshot.topCategories.slice(0, 5).map(category => `
          <div class="list-row">
            <div class="row-main"><p class="row-title">${escapeHTML(category.name)}</p><p class="row-meta">${snapshot.expenses ? Math.round(category.amount / snapshot.expenses * 100) : 0}% of spending</p></div>
            <span class="row-amount">${money(category.amount)}</span>
          </div>`).join("") : emptyState("◎", "No spending yet", "Transactions will create your category breakdown.")}
      </article>

      <article class="card span-7">
        <div class="card-header"><div class="section-title"><span class="section-icon">${icon("transactions")}</span><div><h2>Recent transactions</h2><p>Latest active activity</p></div></div><button class="secondary-button" data-view-jump="transactions">View all</button></div>
        ${snapshot.recentTransactions.length ? snapshot.recentTransactions.map(transaction => transactionRow(transaction)).join("") : emptyState("≡", "Nothing logged yet", "Add income or an expense to begin.")}
      </article>

      <article class="card span-5">
        <div class="card-header"><div class="section-title"><span class="section-icon orange">${icon("calendar")}</span><div><h2>Upcoming</h2><p>Bills and planned costs</p></div></div><button class="secondary-button" data-view-jump="events">Manage</button></div>
        ${snapshot.upcomingBills.length ? snapshot.upcomingBills.slice(0, 5).map(bill => `
          <div class="list-row"><div class="row-main"><p class="row-title">${escapeHTML(bill.name)}</p><p class="row-meta">${formatDate(bill.dueDate)}</p></div><span class="row-amount">${money(bill.amount)}</span></div>
        `).join("") : emptyState("□", "No upcoming bills", "Add recurring costs in Events.")}
      </article>
    </div>`;
}

function transactionRow(transaction) {
  const sign = transaction.type === "income" ? "+" : "−";
  return `<div class="list-row">
    <div class="row-main">
      <p class="row-title">${escapeHTML(transaction.merchant)}</p>
      <p class="row-meta">${formatDate(transaction.date)} · ${escapeHTML(categoryName(transaction.categoryID, transaction.categoryNameSnapshot))} · ${transaction.isBusiness ? "Business" : "Personal"}</p>
    </div>
    <span class="row-amount ${transaction.type === "income" ? "positive" : ""}">${sign}${money(transaction.amount)}</span>
  </div>`;
}

function renderTransactions() {
  const transactions = activeTransactions(state.transactions).sort((a, b) => new Date(b.date) - new Date(a.date));
  return `<div class="page-stack">
    <div class="section-toolbar transaction-toolbar">
      <div class="filter-row" role="search" aria-label="Filter transactions">
        <input class="search-input" id="transaction-search" type="search" placeholder="Search merchant or category">
        <select id="transaction-type-filter" aria-label="Filter transaction type">
          <option value="all">All types</option><option value="income">Income</option><option value="expense">Expenses</option>
        </select>
        <select id="transaction-scope-filter" aria-label="Filter personal or business">
          <option value="all">Personal + business</option><option value="personal">Personal</option><option value="business">Business</option>
        </select>
      </div>
      <button class="primary-button mobile-redundant-action" data-action="add-transaction">${icon("plus")} Add transaction</button>
    </div>
    <div id="transaction-results">
      ${renderTransactionTable(transactions)}
    </div>
  </div>`;
}

function renderTransactionTable(transactions) {
  if (!transactions.length) return emptyState("≡", "No transactions found", "Adjust your filters or add a transaction.");
  return `<div class="data-table-wrap"><table class="data-table">
    <thead><tr><th>Date</th><th>Merchant</th><th>Category</th><th>Scope</th><th>Receipt</th><th class="text-right">Amount</th><th></th></tr></thead>
    <tbody>${transactions.map(transaction => {
      const receipt = transaction.receiptID ? state.receipts.find(item => item.id === transaction.receiptID) : null;
      const image = receipt ? receiptURL(receipt.id) : null;
      const missing = transaction.isTaxDeductible && !image;
      return `<tr>
        <td data-label="Date">${formatDate(transaction.date, { month: "short", day: "numeric" })}</td>
        <td data-label="Merchant"><strong>${escapeHTML(transaction.merchant)}</strong><br><span class="row-meta">${escapeHTML(transaction.paymentMethodName || "Unassigned")}</span></td>
        <td data-label="Category">${escapeHTML(categoryName(transaction.categoryID, transaction.categoryNameSnapshot))}</td>
        <td data-label="Scope"><span class="badge">${transaction.isBusiness ? "Business" : "Personal"}</span></td>
        <td data-label="Receipt">${image ? `<img class="receipt-thumb" src="${image}" alt="Receipt for ${escapeHTML(transaction.merchant)}" data-receipt-url="${image}" role="button" tabindex="0">` : `<span class="badge ${missing ? "warning" : ""}">${missing ? "Missing proof" : "No receipt"}</span>`}</td>
        <td data-label="Amount" class="text-right"><strong class="${transaction.type === "income" ? "positive" : ""}">${transaction.type === "income" ? "+" : "−"}${money(transaction.amount)}</strong></td>
        <td class="table-actions"><div class="row-actions"><button class="icon-button" data-edit-transaction="${transaction.id}" aria-label="Edit ${escapeHTML(transaction.merchant)}">${icon("pencil")}</button><button class="icon-button danger-icon" data-delete-transaction="${transaction.id}" aria-label="Delete ${escapeHTML(transaction.merchant)}">${icon("trash")}</button></div></td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

function renderBudget() {
  const snapshot = calculateSnapshot(state);
  const rows = snapshot.budgetRows.sort((a, b) => b.percent - a.percent);
  return `<div class="page-stack">
    <div class="section-toolbar action-toolbar budget-toolbar">
      <div class="budget-summary"><h2>Monthly budgets</h2><p class="row-meta">${money(snapshot.expenses)} spent · ${money(snapshot.remainingBudget)} remaining</p></div>
      <button class="primary-button" data-action="add-budget">${icon("plus")} Add budget</button>
    </div>
    <div class="dashboard-grid">
      ${rows.length ? rows.map(budget => {
        const percent = Math.round(budget.percent * 100);
        return `<article class="card span-4">
          <div class="card-header"><div><h3>${escapeHTML(budget.categoryName)}</h3><p>${percent}% used</p></div><button class="icon-button" data-edit-budget="${budget.id}" aria-label="Edit ${escapeHTML(budget.categoryName)} budget">${icon("pencil")}</button></div>
          <p class="metric-value">${money(budget.remaining)}</p><p class="metric-foot">remaining of ${money(budget.monthlyAmount)}</p>
          <div class="progress-row"><div class="progress-track"><div class="progress-fill ${percent > 100 ? "over" : percent >= 80 ? "warning" : ""}" style="width:${Math.min(100, Math.max(0, percent))}%"></div></div></div>
          <span class="badge ${percent > 100 ? "danger" : percent >= 80 ? "warning" : "good"}">${percent > 100 ? "Over budget" : percent >= 80 ? "Near limit" : "On track"}</span>
        </article>`;
      }).join("") : `<div class="span-12">${emptyState("◔", "No budgets yet", "Add a category budget to make spending limits visible.")}</div>`}
    </div>
  </div>`;
}

function renderEvents() {
  const events = [...state.events].sort((a, b) => new Date(a.nextDate) - new Date(b.nextDate));
  return `<div class="page-stack">
    <div class="section-toolbar action-toolbar"><div><h2>Events and bills</h2><p class="row-meta">One-time and recurring costs</p></div><button class="primary-button" data-action="add-event">${icon("plus")} Add event</button></div>
    ${events.length ? `<div class="dashboard-grid">${events.map(event => `
      <article class="card span-4">
        <div class="card-header"><div><h3>${escapeHTML(event.name)}</h3><p>${escapeHTML(recurrenceTitle(event.recurrence))}</p></div><button class="icon-button" data-edit-event="${event.id}" aria-label="Edit ${escapeHTML(event.name)}">${icon("pencil")}</button></div>
        <p class="row-meta">${formatDate(event.nextDate)}${event.location ? ` · ${escapeHTML(event.location)}` : ""}</p>
        <p class="metric-value">${money(event.estimatedCost)}</p>
        <p class="metric-foot">${event.estimatedMileage ? `${event.estimatedMileage} estimated miles · ` : ""}${escapeHTML(categoryName(event.categoryID))}</p>
        <div class="event-status"><span class="badge ${event.isActive === false ? "" : "good"}">${event.isActive === false ? "Paused" : "Active"}</span></div>
      </article>`).join("")}</div>` : emptyState("□", "No events yet", "Add bills, subscriptions, conferences, or one-time plans.")}
  </div>`;
}

function recurrenceTitle(value) {
  return ({ oneTime: "One-time", weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly" })[value] || "One-time";
}

function renderMileage() {
  const trips = [...state.mileageTrips].sort((a, b) => new Date(b.date) - new Date(a.date));
  const profile = state.settings.find(item => item.key === "profile") || {};
  const miles = trips.reduce((sum, trip) => sum + Number(trip.miles || 0), 0);
  return `<div class="page-stack">
    <div class="dashboard-grid">
      <article class="card span-4"><p class="metric-label">Total miles</p><p class="metric-value">${miles.toFixed(1)}</p><p class="metric-foot">${trips.length} logged trips</p></article>
      <article class="card span-4"><p class="metric-label">Mileage rate</p><p class="metric-value">${money(profile.defaultMileageRate || 0.7)}</p><p class="metric-foot">per business mile</p></article>
      <article class="card span-4"><p class="metric-label">Deduction estimate</p><p class="metric-value positive">${money(miles * Number(profile.defaultMileageRate || 0.7))}</p><p class="metric-foot">For record organization only</p></article>
    </div>
    <div class="section-toolbar action-toolbar"><div><h2>Trips</h2></div><button class="primary-button" data-action="add-mileage">${icon("plus")} Add trip</button></div>
    ${trips.length ? `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Route</th><th>Purpose</th><th class="text-right">Miles</th><th></th></tr></thead><tbody>
      ${trips.map(trip => `<tr><td data-label="Date">${formatDate(trip.date)}</td><td data-label="Route"><strong>${escapeHTML(trip.startLocation)}</strong><span class="route-arrow">${icon("chevron-right")}</span>${escapeHTML(trip.endLocation)}</td><td data-label="Purpose">${escapeHTML(trip.purpose)}</td><td data-label="Miles" class="text-right"><strong>${Number(trip.miles).toFixed(1)}</strong></td><td class="table-actions"><button class="icon-button danger-icon" data-delete-mileage="${trip.id}" aria-label="Delete trip">${icon("trash")}</button></td></tr>`).join("")}
    </tbody></table></div>` : emptyState("↗", "No mileage logged", "Add a business trip to estimate mileage deductions.")}
  </div>`;
}

function renderReports() {
  const snapshot = calculateSnapshot(state);
  const business = snapshot.monthly.filter(item => item.isBusiness);
  const personal = snapshot.monthly.filter(item => !item.isBusiness);
  const deductible = snapshot.transactions.filter(item => item.type === "expense" && item.isTaxDeductible);
  const receiptIDs = new Set((state.receipts || []).map(receipt => receipt.id));
  const proof = deductible.filter(item => item.receiptAttached && receiptIDs.has(item.receiptID));
  const missing = deductible.filter(item => !item.receiptAttached || !receiptIDs.has(item.receiptID));
  const total = list => list.filter(item => item.type === "expense").reduce((sum, item) => sum + Number(item.amount), 0);
  return `<div class="page-stack">
    <div class="dashboard-grid">
      <article class="card span-3"><p class="metric-label">Income</p><p class="metric-value positive">${money(snapshot.income)}</p><p class="metric-foot">Current month</p></article>
      <article class="card span-3"><p class="metric-label">Personal spending</p><p class="metric-value">${money(total(personal))}</p><p class="metric-foot">${personal.length} transactions</p></article>
      <article class="card span-3"><p class="metric-label">Business spending</p><p class="metric-value">${money(total(business))}</p><p class="metric-foot">${business.length} transactions</p></article>
      <article class="card span-3"><p class="metric-label">Net</p><p class="metric-value ${snapshot.net >= 0 ? "positive" : "negative"}">${money(snapshot.net)}</p><p class="metric-foot">Current month</p></article>
      <article class="card span-7">
        <div class="card-header"><div><h2>Budget vs actual</h2><p>Current month</p></div></div>
        ${snapshot.budgetRows.length ? snapshot.budgetRows.map(row => `<div class="list-row"><div class="row-main"><p class="row-title">${escapeHTML(row.categoryName)}</p><p class="row-meta">Budget ${money(row.monthlyAmount)}</p></div><span class="row-amount">${money(row.spent)}</span></div>`).join("") : emptyState("▥", "No budget data", "Add category budgets for comparisons.")}
      </article>
      <article class="card span-5">
        <div class="card-header"><div><h2>Receipt documentation</h2><p>Deductible expense proof</p></div></div>
        <div class="list-row"><div class="row-main"><p class="row-title">With receipts</p><p class="row-meta">${proof.length} expenses</p></div><span class="row-amount">${money(proof.reduce((sum,item)=>sum+Number(item.amount),0))}</span></div>
        <div class="list-row"><div class="row-main"><p class="row-title">Missing receipts</p><p class="row-meta">${missing.length} expenses</p></div><span class="row-amount">${money(missing.reduce((sum,item)=>sum+Number(item.amount),0))}</span></div>
      </article>
      <div class="span-12 callout">This app helps organize financial data but does not provide tax, legal, or accounting advice. Consult a qualified professional.</div>
    </div>
  </div>`;
}

function renderImport() {
  const backup = currentBackupPreview;
  const csv = currentCSVPreview;
  return `<div class="page-stack">
    <div class="callout">All documents are processed locally in this browser. Your financial data never leaves this device.</div>
    <div class="dashboard-grid">
      <article class="card span-6">
        <div class="card-header"><div><h2>Portable Scope backup</h2><p>ZIP from iPhone or Scope web</p></div></div>
        <div class="drop-zone" id="backup-drop-zone">
          <p><strong>Choose a Scope portable backup</strong></p>
          <p class="row-meta">The archive is validated before anything is saved.</p>
          <input id="backup-file" type="file" accept=".zip,application/zip">
        </div>
        ${backup ? backupPreviewMarkup(backup) : ""}
      </article>
      <article class="card span-6">
        <div class="card-header"><div><h2>Bank or wallet CSV</h2><p>Transaction amount and balance are separated</p></div></div>
        <div class="drop-zone">
          <p><strong>Choose a CSV export</strong></p>
          <p class="row-meta">CSV is the most reliable statement format.</p>
          <input id="csv-file" type="file" accept=".csv,text/csv">
        </div>
        ${csv ? csvPreviewMarkup(csv) : ""}
      </article>
    </div>
  </div>`;
}

function backupPreviewMarkup(preview) {
  return `<div class="preview-block">
    <h3>Review backup</h3>
    <div class="list-row"><span>Transactions</span><strong>${preview.manifest.counts.transactions || preview.manifest.transactions.length}</strong></div>
    <div class="list-row"><span>Receipts</span><strong>${preview.manifest.counts.receipts || preview.manifest.receipts.length}</strong></div>
    <div class="list-row"><span>Existing matches</span><strong>${preview.duplicateIDs + preview.duplicateFingerprints}</strong></div>
    <div class="list-row"><span>Missing receipt files</span><strong>${preview.missingReceipts.length}</strong></div>
    ${preview.warnings.length ? `<div class="callout warning preview-warning">${preview.warnings.map(escapeHTML).join("<br>")}</div>` : ""}
    <div class="filter-row preview-actions">
      <button class="primary-button" data-action="restore-merge">Safe Merge</button>
      <button class="danger-button" data-action="restore-replace">Full Restore</button>
    </div>
  </div>`;
}

function csvPreviewMarkup(preview) {
  return `<div class="preview-block">
    <h3>Import preview</h3>
    <p class="row-meta">${preview.transactions.length} rows found · balance values are reference-only</p>
    <div class="list">${preview.transactions.slice(0, 5).map(item => `<div class="list-row"><div class="row-main"><p class="row-title">${escapeHTML(item.merchant)}</p><p class="row-meta">${formatDate(item.date)} · ${item.type === "income" ? "Deposit" : "Expense"}${item.balanceAfterTransaction != null ? ` · Balance after ${money(item.balanceAfterTransaction)}` : ""}</p></div><span class="row-amount">${money(item.amount)}</span></div>`).join("")}</div>
    ${preview.warnings.length ? `<div class="callout warning">${preview.warnings.map(escapeHTML).join("<br>")}</div>` : ""}
    <button class="primary-button preview-submit" data-action="confirm-csv-import">Import ${preview.transactions.length} transactions</button>
  </div>`;
}

function renderSettings() {
  const profile = state.settings.find(item => item.key === "profile") || {};
  return `<div class="dashboard-grid">
    <article class="card span-7">
      <div class="card-header"><div><h2>Profile</h2><p>Saved automatically in this browser</p></div></div>
      <form id="settings-form" class="form-grid">
        <div class="field full"><label for="business-name">Profile or business name</label><input id="business-name" name="businessName" value="${escapeHTML(profile.businessName || "Scope")}"></div>
        <div class="field"><label for="tax-year">Tax year</label><input id="tax-year" name="taxYear" type="number" min="2020" max="2100" value="${Number(profile.taxYear || new Date().getFullYear())}"></div>
        <div class="field"><label for="mileage-rate">Mileage rate</label><input id="mileage-rate" name="defaultMileageRate" type="number" min="0" step="0.01" value="${Number(profile.defaultMileageRate || 0.7)}"></div>
        <div class="field full"><button class="primary-button" type="submit">Save settings</button></div>
      </form>
    </article>
    <article class="card span-5">
      <div class="card-header"><div><h2>Backup & transfer</h2><p>Compatible with Scope for iPhone</p></div></div>
      <div class="button-stack"><button class="primary-button" data-action="export-backup">Create Portable Backup</button>
      <button class="secondary-button" data-view-jump="import">Restore a Backup</button></div>
      <p class="row-meta backup-note">Includes soft-deleted history, relationships, and locally stored receipt files.</p>
    </article>
    <article class="card span-7">
      <div class="card-header"><div><h2>Categories</h2><p>Personal and business organization</p></div><button class="secondary-button" data-action="add-category">${icon("plus")} Add</button></div>
      <div class="list">${state.categories.map(category => `<div class="list-row"><div class="row-main"><p class="row-title">${escapeHTML(category.name)}</p><p class="row-meta">${category.isIncomeCategory ? "Income" : "Expense"} category</p></div><button class="icon-button danger-icon" data-delete-category="${category.id}" aria-label="Delete ${escapeHTML(category.name)}">${icon("trash")}</button></div>`).join("")}</div>
    </article>
    <article class="card span-5">
      <div class="card-header"><div><h2>Savings goals</h2><p>Track progress toward your priorities</p></div><button class="secondary-button" data-action="add-goal">${icon("plus")} Add</button></div>
      ${state.savingsGoals.length ? state.savingsGoals.map(goal => `<div class="list-row"><div class="row-main"><p class="row-title">${escapeHTML(goal.name)}</p><p class="row-meta">${money(goal.savedAmount)} saved of ${money(goal.targetAmount)}</p></div><button class="icon-button danger-icon" data-delete-goal="${goal.id}" aria-label="Delete goal">${icon("trash")}</button></div>`).join("") : emptyState("◇", "No savings goals", "Add a target to track your progress.")}
    </article>
    <div class="span-12 callout">Scope stores web data in IndexedDB on this device. Clearing browser site data removes it, so create portable backups regularly.</div>
  </div>`;
}

async function runButtonTask(button, task) {
  if (button.dataset.busy === "true") return;
  button.dataset.busy = "true";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await task();
  } catch (error) {
    showToast(error?.message || "Scope could not complete that action.");
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      delete button.dataset.busy;
    }
  }
}

function bindViewEvents() {
  content.querySelectorAll("[data-view-jump]").forEach(button => button.addEventListener("click", () => setView(button.dataset.viewJump)));
  content.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => runButtonTask(button, () => handleAction(button.dataset.action))));

  content.querySelectorAll("[data-edit-transaction]").forEach(button => button.addEventListener("click", () => openTransactionModal(state.transactions.find(item => item.id === button.dataset.editTransaction))));
  content.querySelectorAll("[data-delete-transaction]").forEach(button => button.addEventListener("click", () => softDeleteTransaction(button.dataset.deleteTransaction)));
  bindReceiptPreviewEvents();
  content.querySelectorAll("[data-edit-budget]").forEach(button => button.addEventListener("click", () => openBudgetModal(state.budgets.find(item => item.id === button.dataset.editBudget))));
  content.querySelectorAll("[data-edit-event]").forEach(button => button.addEventListener("click", () => openEventModal(state.events.find(item => item.id === button.dataset.editEvent))));
  content.querySelectorAll("[data-delete-mileage]").forEach(button => button.addEventListener("click", () => runButtonTask(button, async () => { await deleteRecord(db, "mileageTrips", button.dataset.deleteMileage); await reload(); showToast("Trip deleted."); })));
  content.querySelectorAll("[data-delete-category]").forEach(button => button.addEventListener("click", () => runButtonTask(button, () => deleteCategory(button.dataset.deleteCategory))));
  content.querySelectorAll("[data-delete-goal]").forEach(button => button.addEventListener("click", () => runButtonTask(button, async () => { await deleteRecord(db, "savingsGoals", button.dataset.deleteGoal); await reload(); showToast("Savings goal deleted."); })));

  const search = content.querySelector("#transaction-search");
  const type = content.querySelector("#transaction-type-filter");
  const scope = content.querySelector("#transaction-scope-filter");
  const applyFiltersNow = () => {
    if (!search?.isConnected || currentView !== "transactions") return;
    const query = search.value.toLowerCase();
    const matches = activeTransactions(state.transactions)
      .filter(item => type.value === "all" || item.type === type.value)
      .filter(item => scope.value === "all" || (scope.value === "business" ? item.isBusiness : !item.isBusiness))
      .filter(item => !query || String(item.merchant).toLowerCase().includes(query) || categoryName(item.categoryID, item.categoryNameSnapshot).toLowerCase().includes(query))
      .sort((a,b) => new Date(b.date) - new Date(a.date));
    const results = content.querySelector("#transaction-results");
    if (!results) return;
    results.innerHTML = renderTransactionTable(matches);
    bindTransactionResultEvents();
  };
  const applyFilters = debounce(applyFiltersNow, 120);
  search?.addEventListener("input", applyFilters);
  type?.addEventListener("change", () => { applyFilters.cancel(); applyFiltersNow(); });
  scope?.addEventListener("change", () => { applyFilters.cancel(); applyFiltersNow(); });

  content.querySelector("#settings-form")?.addEventListener("submit", saveSettings);
  content.querySelector("#backup-file")?.addEventListener("change", handleBackupFile);
  content.querySelector("#csv-file")?.addEventListener("change", handleCSVFile);
}

function bindTransactionResultEvents() {
  content.querySelectorAll("[data-edit-transaction]").forEach(button => button.addEventListener("click", () => openTransactionModal(state.transactions.find(item => item.id === button.dataset.editTransaction))));
  content.querySelectorAll("[data-delete-transaction]").forEach(button => button.addEventListener("click", () => softDeleteTransaction(button.dataset.deleteTransaction)));
  bindReceiptPreviewEvents();
}

function bindReceiptPreviewEvents(root = content) {
  root.querySelectorAll("[data-receipt-url]").forEach(image => {
    image.addEventListener("click", () => openImageViewer(image.dataset.receiptUrl, image.alt));
    image.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openImageViewer(image.dataset.receiptUrl, image.alt);
      }
    });
  });
}

function handleAction(action) {
  switch (action) {
    case "add-transaction": return openTransactionModal();
    case "add-budget": return openBudgetModal();
    case "add-event": return openEventModal();
    case "add-mileage": return openMileageModal();
    case "add-category": return openCategoryModal();
    case "add-goal": return openGoalModal();
    case "export-backup": return exportBackup();
    case "restore-merge": return restoreBackup("merge");
    case "restore-replace": return restoreBackup("replace");
    case "confirm-csv-import": return importCSVPreview();
    default: throw new Error("Unknown Scope action.");
  }
}

function openModal({ heading, body, submitLabel = "Save", onSubmit, dangerAction = null, wide = false }) {
  modalReturnFocus = document.activeElement;
  modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <header class="modal-header"><h2 id="modal-title">${escapeHTML(heading)}</h2><button class="icon-button" type="button" data-close-modal aria-label="Close">${icon("x")}</button></header>
    <form id="modal-form">
      <div class="modal-body">${body}</div>
      <footer class="modal-footer">${dangerAction ? '<button class="danger-button" type="button" id="modal-danger">Delete</button>' : ""}<button class="secondary-button" type="button" data-close-modal>Cancel</button><button class="primary-button" type="submit">${escapeHTML(submitLabel)}</button></footer>
    </form>
  </section></div>`;
  modalRoot.querySelectorAll("[data-close-modal]").forEach(button => button.addEventListener("click", closeModal));
  modalRoot.querySelector(".modal-backdrop").addEventListener("click", event => { if (event.target === event.currentTarget) closeModal(); });
  const modal = modalRoot.querySelector(".modal");
  const modalHeader = modalRoot.querySelector(".modal-header");
  let dragStart = null;
  modalHeader.addEventListener("pointerdown", event => {
    if (window.innerWidth > 720 || event.target.closest("button")) return;
    dragStart = event.clientY;
    modalHeader.setPointerCapture(event.pointerId);
    modal.classList.add("is-dragging");
  });
  modalHeader.addEventListener("pointermove", event => {
    if (dragStart == null) return;
    modal.style.setProperty("--modal-drag", `${Math.max(0, event.clientY - dragStart)}px`);
  });
  const finishDrag = event => {
    if (dragStart == null) return;
    const distance = Math.max(0, event.clientY - dragStart);
    dragStart = null;
    modal.classList.remove("is-dragging");
    if (distance > 96) closeModal();
    else modal.style.removeProperty("--modal-drag");
  };
  modalHeader.addEventListener("pointerup", finishDrag);
  modalHeader.addEventListener("pointercancel", () => {
    dragStart = null;
    modal.classList.remove("is-dragging");
    modal.style.removeProperty("--modal-drag");
  });
  modalRoot.querySelector("#modal-form").addEventListener("focusin", event => {
    if (window.innerWidth <= 720 && event.target.matches("input, select, textarea")) {
      window.setTimeout(() => event.target.scrollIntoView({ block: "center", behavior: "smooth" }), 120);
    }
  });
  modalRoot.querySelector("#modal-form").addEventListener("submit", async event => {
    event.preventDefault();
    const modalForm = event.currentTarget;
    if (modalForm.dataset.busy === "true") return;
    modalForm.dataset.busy = "true";
    const submitButton = event.submitter;
    if (submitButton) submitButton.disabled = true;
    try {
      await onSubmit(new FormData(event.currentTarget));
      closeModal();
    } catch (error) {
      showToast(error?.message || "Scope could not save those changes.");
      if (submitButton) submitButton.disabled = false;
      delete modalForm.dataset.busy;
    }
  });
  if (dangerAction) {
    const dangerButton = modalRoot.querySelector("#modal-danger");
    dangerButton.addEventListener("click", () => runButtonTask(dangerButton, dangerAction));
  }
  syncOverlayState();
  setTimeout(() => modalRoot.querySelector("input, select, textarea")?.focus(), 30);
  return modal;
}

function closeModal() {
  modalRoot.innerHTML = "";
  syncOverlayState();
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
  modalReturnFocus = null;
}

function openMoreMenu() {
  modalReturnFocus = document.activeElement;
  const items = [
    ["mileage", "Mileage", "mileage", "Trips and deductions"],
    ["reports", "Reports", "reports", "Financial summaries"],
    ["import", "Import", "import", "Local documents and backups"],
    ["settings", "Settings", "settings", "Profile and categories"]
  ];
  modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal more-modal" role="dialog" aria-modal="true" aria-labelledby="more-menu-title">
    <header class="modal-header"><h2 id="more-menu-title">More</h2><button class="icon-button" type="button" data-close-modal aria-label="Close">${icon("x")}</button></header>
    <div class="modal-body more-menu">${items.map(([view, label, symbol, detail]) => `<button class="more-menu-item" type="button" data-more-view="${view}"><span class="section-icon">${icon(symbol)}</span><span><strong>${label}</strong><small>${detail}</small></span>${icon("chevron-right", "more-chevron")}</button>`).join("")}</div>
  </section></div>`;
  modalRoot.querySelectorAll("[data-close-modal]").forEach(button => button.addEventListener("click", closeModal));
  modalRoot.querySelector(".modal-backdrop").addEventListener("click", event => { if (event.target === event.currentTarget) closeModal(); });
  modalRoot.querySelectorAll("[data-more-view]").forEach(button => button.addEventListener("click", () => {
    const view = button.dataset.moreView;
    closeModal();
    setView(view);
  }));
  syncOverlayState();
  setTimeout(() => modalRoot.querySelector("[data-more-view]")?.focus(), 30);
}

function openTransactionModal(transaction = null) {
  const selectedCategory = transaction?.categoryID || state.categories.find(category => category.isIncomeCategory === (transaction?.type === "income"))?.id || "";
  const receiptImage = transaction?.receiptID ? receiptURL(transaction.receiptID) : null;
  const modal = openModal({
    heading: transaction ? "Edit transaction" : "Add transaction",
    submitLabel: transaction ? "Save changes" : "Add transaction",
    body: `<div class="form-grid">
      <div class="field"><label for="tx-type">Type</label><select id="tx-type" name="type"><option value="expense" ${transaction?.type !== "income" ? "selected" : ""}>Expense</option><option value="income" ${transaction?.type === "income" ? "selected" : ""}>Income</option></select></div>
      <div class="field"><label for="tx-amount">Amount</label><input id="tx-amount" name="amount" type="number" min="0.01" step="0.01" required value="${transaction?.amount ?? ""}"></div>
      <div class="field"><label for="tx-date">Date</label><input id="tx-date" name="date" type="date" required value="${dateInput(transaction?.date)}"></div>
      <div class="field"><label for="tx-merchant">Merchant or source</label><input id="tx-merchant" name="merchant" required value="${escapeHTML(transaction?.merchant || "")}"></div>
      <div class="field"><label for="tx-category">Category</label><select id="tx-category" name="categoryID">${categoryOptions(selectedCategory)}</select></div>
      <div class="field"><label for="tx-payment">Payment method</label><select id="tx-payment" name="paymentMethodName">${paymentOptions(transaction?.paymentMethodName || "Checking")}</select></div>
      <label class="switch-row"><input type="checkbox" name="isBusiness" ${transaction?.isBusiness ? "checked" : ""}><span class="switch-track" aria-hidden="true"></span><span>Business transaction</span></label>
      <label class="switch-row" id="tx-tax-row"><input type="checkbox" name="isTaxDeductible" ${transaction?.isTaxDeductible ? "checked" : ""} ${transaction?.type === "income" ? "disabled" : ""}><span class="switch-track" aria-hidden="true"></span><span>Tax-deductible expense</span></label>
      <div class="field full"><label for="tx-notes">Notes</label><textarea id="tx-notes" name="notes">${escapeHTML(transaction?.notes || "")}</textarea></div>
      <div class="field full receipt-field"><label for="tx-receipt">Receipt image</label>
        ${receiptImage ? `<div class="receipt-attachment" id="tx-receipt-attachment"><img src="${receiptImage}" alt="Attached receipt for ${escapeHTML(transaction?.merchant || "transaction")}" data-receipt-url="${receiptImage}" role="button" tabindex="0"><div><strong>Receipt attached</strong><button class="danger-button compact-button" id="remove-tx-receipt" type="button">Remove</button></div></div>` : ""}
        <input id="tx-receipt" name="receipt" type="file" accept="image/*">
        <input id="tx-remove-receipt" name="removeReceipt" type="hidden" value="false">
        <span class="row-meta" id="tx-receipt-help">${transaction?.receiptID ? "Choose a file to replace the attached receipt." : "Optional. Stored only in this browser."}</span>
      </div>
    </div>`,
    onSubmit: async form => {
      const category = state.categories.find(item => item.id === form.get("categoryID"));
      const now = new Date().toISOString();
      const record = {
        ...(transaction || {}),
        id: transaction?.id || crypto.randomUUID(),
        amount: Number(form.get("amount")),
        date: new Date(`${form.get("date")}T12:00:00`).toISOString(),
        type: form.get("type"),
        merchant: form.get("merchant").trim(),
        isBusiness: form.has("isBusiness"),
        isTaxDeductible: form.has("isTaxDeductible"),
        notes: form.get("notes").trim(),
        paymentMethodName: form.get("paymentMethodName"),
        categoryNameSnapshot: category?.name || "Uncategorized",
        categoryID: category?.id || null,
        eventID: transaction?.eventID || null,
        accountID: form.get("paymentMethodName"),
        status: "active",
        deletedAt: null,
        createdAt: transaction?.createdAt || now,
        updatedAt: now,
        receiptImagePath: transaction?.receiptImagePath || null,
        receiptAttached: Boolean(transaction?.receiptID),
        receiptAddedDate: transaction?.receiptAddedDate || null,
        importSourceHash: transaction?.importSourceHash || null,
        importSourceName: transaction?.importSourceName || null,
        sourceImportID: transaction?.sourceImportID || null,
        sourceFileHash: transaction?.sourceFileHash || null
      };
      const receiptFile = form.get("receipt");
      if (form.get("removeReceipt") === "true" && transaction?.receiptID && !receiptFile?.size) {
        await deleteRecord(db, "receipts", transaction.receiptID);
        record.receiptID = null;
        record.receiptImagePath = null;
        record.receiptAttached = false;
        record.receiptAddedDate = null;
      }
      if (receiptFile?.size) {
        const receiptID = transaction?.receiptID || crypto.randomUUID();
        const relativePath = `receipts/${record.id}/${receiptFile.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        await putRecord(db, "receipts", {
          id: receiptID,
          transactionID: record.id,
          fileName: receiptFile.name,
          note: "",
          addedAt: now,
          relativePath,
          byteCount: receiptFile.size,
          isMissing: false,
          blob: receiptFile
        });
        record.receiptID = receiptID;
        record.receiptImagePath = relativePath;
        record.receiptAttached = true;
        record.receiptAddedDate = now;
      }
      record.transactionFingerprint = transactionFingerprint(record);
      await putRecord(db, "transactions", record);
      await reload();
      showToast(transaction ? "Transaction updated." : "Transaction added.");
    }
  });
  bindReceiptPreviewEvents(modal);
  const typeSelect = modal.querySelector("#tx-type");
  const taxInput = modal.querySelector('[name="isTaxDeductible"]');
  const taxRow = modal.querySelector("#tx-tax-row");
  const syncTaxState = () => {
    const disabled = typeSelect.value === "income";
    taxInput.disabled = disabled;
    if (disabled) taxInput.checked = false;
    taxRow.classList.toggle("is-disabled", disabled);
  };
  typeSelect.addEventListener("change", syncTaxState);
  syncTaxState();
  modal.querySelector("#remove-tx-receipt")?.addEventListener("click", () => {
    modal.querySelector("#tx-remove-receipt").value = "true";
    modal.querySelector("#tx-receipt-attachment").hidden = true;
    modal.querySelector("#tx-receipt-help").textContent = "Receipt will be removed when you save.";
  });
}

async function softDeleteTransaction(id) {
  const transaction = state.transactions.find(item => item.id === id);
  if (!transaction || !confirm(`Delete ${transaction.merchant}? It can still be restored from a portable backup.`)) return;
  await putRecord(db, "transactions", { ...transaction, status: "deleted", deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await reload();
  showToast("Transaction moved to deleted history.");
}

function openBudgetModal(budget = null) {
  openModal({
    heading: budget ? "Edit budget" : "Add budget",
    body: `<div class="form-grid">
      <div class="field full"><label for="budget-category">Category</label><select id="budget-category" name="categoryID" required>${categoryOptions(budget?.categoryID, false)}</select></div>
      <div class="field"><label for="budget-amount">Monthly amount</label><input id="budget-amount" name="monthlyAmount" type="number" min="0" step="1" required value="${budget?.monthlyAmount ?? ""}"></div>
      <div class="field"><label for="budget-threshold">Alert at</label><select id="budget-threshold" name="alertThreshold"><option value="0.75" ${budget?.alertThreshold === .75 ? "selected" : ""}>75%</option><option value="0.8" ${!budget || budget.alertThreshold === .8 ? "selected" : ""}>80%</option><option value="0.9" ${budget?.alertThreshold === .9 ? "selected" : ""}>90%</option></select></div>
      <label class="switch-row full"><input type="checkbox" name="rolloverEnabled" ${budget?.rolloverEnabled ? "checked" : ""}><span class="switch-track" aria-hidden="true"></span><span>Roll unused budget forward</span></label>
    </div>`,
    dangerAction: budget ? async () => { await deleteRecord(db, "budgets", budget.id); closeModal(); await reload(); showToast("Budget deleted."); } : null,
    onSubmit: async form => {
      const categoryID = form.get("categoryID");
      const existing = state.budgets.find(item => item.categoryID === categoryID && item.id !== budget?.id);
      if (existing) throw new Error("This category already has a budget.");
      await putRecord(db, "budgets", {
        id: budget?.id || crypto.randomUUID(),
        categoryID,
        monthlyAmount: Number(form.get("monthlyAmount")),
        rolloverEnabled: form.has("rolloverEnabled"),
        alertThreshold: Number(form.get("alertThreshold"))
      });
      await reload();
      showToast("Budget saved.");
    }
  });
}

function openEventModal(event = null) {
  openModal({
    heading: event ? "Edit event" : "Add event",
    body: `<div class="form-grid">
      <div class="field full"><label for="event-name">Event or bill name</label><input id="event-name" name="name" required value="${escapeHTML(event?.name || "")}"></div>
      <div class="field"><label for="event-date">Next date</label><input id="event-date" name="nextDate" type="date" required value="${dateInput(event?.nextDate)}"></div>
      <div class="field"><label for="event-end">End date</label><input id="event-end" name="endDate" type="date" value="${event?.endDate ? dateInput(event.endDate) : ""}"></div>
      <div class="field"><label for="event-repeat">Repeats</label><select id="event-repeat" name="recurrence"><option value="oneTime">One-time</option><option value="weekly" ${event?.recurrence === "weekly" ? "selected" : ""}>Weekly</option><option value="monthly" ${event?.recurrence === "monthly" ? "selected" : ""}>Monthly</option><option value="quarterly" ${event?.recurrence === "quarterly" ? "selected" : ""}>Quarterly</option></select></div>
      <div class="field"><label for="event-category">Category</label><select id="event-category" name="categoryID">${categoryOptions(event?.categoryID, false)}</select></div>
      <div class="field"><label for="event-cost">Estimated cost</label><input id="event-cost" name="estimatedCost" type="number" min="0" step="0.01" value="${event?.estimatedCost || ""}"></div>
      <div class="field"><label for="event-miles">Estimated mileage</label><input id="event-miles" name="estimatedMileage" type="number" min="0" step="0.1" value="${event?.estimatedMileage || ""}"></div>
      <div class="field full"><label for="event-location">Location</label><input id="event-location" name="location" value="${escapeHTML(event?.location || "")}"></div>
      <div class="field full"><label for="event-notes">Notes</label><textarea id="event-notes" name="notes">${escapeHTML(event?.notes || "")}</textarea></div>
      <label class="switch-row full"><input type="checkbox" name="isActive" ${event?.isActive === false ? "" : "checked"}><span class="switch-track" aria-hidden="true"></span><span>Active</span></label>
    </div>`,
    dangerAction: event ? async () => { await deleteRecord(db, "events", event.id); closeModal(); await reload(); showToast("Event deleted."); } : null,
    onSubmit: async form => {
      await putRecord(db, "events", {
        id: event?.id || crypto.randomUUID(),
        name: form.get("name").trim(),
        recurrence: form.get("recurrence"),
        estimatedCost: Number(form.get("estimatedCost") || 0),
        estimatedMileage: Number(form.get("estimatedMileage") || 0),
        nextDate: new Date(`${form.get("nextDate")}T12:00:00`).toISOString(),
        endDate: form.get("endDate") ? new Date(`${form.get("endDate")}T12:00:00`).toISOString() : null,
        location: form.get("location").trim(),
        isActive: form.has("isActive"),
        isTemplate: false,
        notes: form.get("notes").trim(),
        skippedOccurrences: event?.skippedOccurrences || 0,
        categoryID: form.get("categoryID") || null
      });
      await reload();
      showToast("Event saved.");
    }
  });
}

function openMileageModal() {
  openModal({
    heading: "Add mileage trip",
    body: `<div class="form-grid">
      <div class="field"><label for="trip-date">Date</label><input id="trip-date" name="date" type="date" required value="${dateInput()}"></div>
      <div class="field"><label for="trip-miles">Miles</label><input id="trip-miles" name="miles" type="number" min="0.1" step="0.1" required></div>
      <div class="field"><label for="trip-start">Start location</label><input id="trip-start" name="startLocation" required></div>
      <div class="field"><label for="trip-end">End location</label><input id="trip-end" name="endLocation" required></div>
      <div class="field full"><label for="trip-purpose">Business purpose</label><input id="trip-purpose" name="purpose" required></div>
    </div>`,
    onSubmit: async form => {
      await putRecord(db, "mileageTrips", {
        id: crypto.randomUUID(),
        date: new Date(`${form.get("date")}T12:00:00`).toISOString(),
        startLocation: form.get("startLocation").trim(),
        endLocation: form.get("endLocation").trim(),
        miles: Number(form.get("miles")),
        purpose: form.get("purpose").trim(),
        eventID: null,
        linkedExpenseID: null
      });
      await reload();
      showToast("Mileage trip added.");
    }
  });
}

function openCategoryModal() {
  openModal({
    heading: "Add category",
    body: `<div class="form-grid">
      <div class="field full"><label for="category-name">Name</label><input id="category-name" name="name" required></div>
      <div class="field"><label for="category-color">Color</label><input id="category-color" name="colorHex" type="color" value="#0d8a55"></div>
      <div class="field"><label for="category-symbol">Short symbol name</label><input id="category-symbol" name="symbol" value="tag"></div>
      <label class="switch-row full"><input type="checkbox" name="isIncomeCategory"><span class="switch-track" aria-hidden="true"></span><span>Income category</span></label>
    </div>`,
    onSubmit: async form => {
      await putRecord(db, "categories", {
        id: crypto.randomUUID(),
        name: form.get("name").trim(),
        symbol: form.get("symbol").trim() || "tag",
        colorHex: form.get("colorHex"),
        isDefault: false,
        isIncomeCategory: form.has("isIncomeCategory"),
        createdAt: new Date().toISOString()
      });
      await reload();
      showToast("Category added.");
    }
  });
}

async function deleteCategory(id) {
  if (state.budgets.some(item => item.categoryID === id) || activeTransactions(state.transactions).some(item => item.categoryID === id)) {
    showToast("This category is in use. Reassign its transactions and budget first.");
    return;
  }
  if (!confirm("Delete this category?")) return;
  await deleteRecord(db, "categories", id);
  await reload();
}

function openGoalModal() {
  openModal({
    heading: "Add savings goal",
    body: `<div class="form-grid">
      <div class="field full"><label for="goal-name">Goal name</label><input id="goal-name" name="name" required></div>
      <div class="field"><label for="goal-target">Target amount</label><input id="goal-target" name="targetAmount" type="number" min="1" step="1" required></div>
      <div class="field"><label for="goal-saved">Already saved</label><input id="goal-saved" name="savedAmount" type="number" min="0" step="1" value="0"></div>
      <div class="field full"><label for="goal-date">Target date</label><input id="goal-date" name="targetDate" type="date"></div>
    </div>`,
    onSubmit: async form => {
      await putRecord(db, "savingsGoals", {
        id: crypto.randomUUID(),
        name: form.get("name").trim(),
        targetAmount: Number(form.get("targetAmount")),
        savedAmount: Number(form.get("savedAmount") || 0),
        targetDate: form.get("targetDate") ? new Date(`${form.get("targetDate")}T12:00:00`).toISOString() : null
      });
      await reload();
      showToast("Savings goal added.");
    }
  });
}

async function saveSettings(event) {
  event.preventDefault();
  const settingsForm = event.currentTarget;
  if (settingsForm.dataset.busy === "true") return;
  settingsForm.dataset.busy = "true";
  const submitButton = event.submitter;
  if (submitButton?.disabled) return;
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.setAttribute("aria-busy", "true");
  }
  const form = new FormData(settingsForm);
  const currentProfile = state.settings.find(item => item.key === "profile") || {};
  try {
    await putRecord(db, "settings", {
      ...currentProfile,
      key: "profile",
      businessName: form.get("businessName").trim() || "Scope",
      taxYear: Number(form.get("taxYear")),
      defaultMileageRate: Number(form.get("defaultMileageRate"))
    });
    await reload();
    showToast("Settings saved.");
  } catch (error) {
    showToast(error?.message || "Settings could not be saved.");
    if (submitButton?.isConnected) {
      submitButton.disabled = false;
      submitButton.removeAttribute("aria-busy");
    }
  } finally {
    if (settingsForm.isConnected) delete settingsForm.dataset.busy;
  }
}

async function handleBackupFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    event.target.setAttribute("aria-busy", "true");
    await yieldToBrowser();
    currentBackupPreview = previewArchive(await file.arrayBuffer(), state);
    renderView();
    showToast("Backup validated. Review before restoring.");
  } catch (error) {
    currentBackupPreview = null;
    renderView();
    showToast(error?.message || "That backup could not be read.");
  } finally {
    if (event.target.isConnected) event.target.removeAttribute("aria-busy");
  }
}

async function restoreBackup(mode) {
  if (!currentBackupPreview) return;
  if (mode === "replace") {
    const accepted = confirm("Full Restore will replace this browser's current Scope records. A safety backup will download first. Continue?");
    if (!accepted) return;
    const safetyBackupCreated = await exportBackup("Scope-Pre-Restore-Safety-Backup.zip", false);
    if (!safetyBackupCreated) {
      showToast("Full Restore stopped because the safety backup could not be created.");
      return;
    }
  }
  try {
    const result = await restorePortableBackup(db, currentBackupPreview, state, mode);
    currentBackupPreview = null;
    await reload();
    showToast(`Restored ${result.insertedTransactions} transactions and ${result.restoredReceipts} receipts.`);
  } catch (error) {
    showToast(`Restore rolled back: ${error.message}`);
  }
}

async function handleCSVFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    event.target.setAttribute("aria-busy", "true");
    const sourceHash = await sha256Hex(file);
    const text = await file.text();
    await yieldToBrowser();
    currentCSVPreview = parseFinancialCSV(text, { sourceName: file.name, sourceHash });
    const existing = new Set(activeTransactions(state.transactions).map(item => item.transactionFingerprint));
    currentCSVPreview.transactions = currentCSVPreview.transactions.filter(item => !existing.has(item.transactionFingerprint));
    renderView();
    showToast("CSV parsed locally. Review the rows before importing.");
  } catch (error) {
    currentCSVPreview = null;
    renderView();
    showToast(error?.message || "That CSV could not be imported.");
  } finally {
    if (event.target.isConnected) event.target.removeAttribute("aria-busy");
  }
}

async function importCSVPreview() {
  if (!currentCSVPreview?.transactions.length) return;
  const categoryByName = new Map(state.categories.map(category => [category.name.toLowerCase(), category.id]));
  const transactions = currentCSVPreview.transactions.map(transaction => ({
    ...transaction,
    categoryID: categoryByName.get(transaction.categoryNameSnapshot.toLowerCase()) || null
  }));
  const plan = {
    transactions,
    imports: [{
      id: crypto.randomUUID(),
      source: "csv",
      importedAt: new Date().toISOString(),
      rowCount: transactions.length
    }]
  };
  await applyImportPlan(db, plan, [], "merge");
  currentCSVPreview = null;
  await reload();
  showToast(`Imported ${transactions.length} transactions.`);
}

async function exportBackup(filename = null, notify = true) {
  try {
    await yieldToBrowser();
    const bytes = await createPortableBackup(state);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename || `Scope-Portable-Backup-${dateInput()}.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (notify) showToast("Portable backup created.");
    return true;
  } catch (error) {
    showToast(error?.message || "The portable backup could not be created.");
    return false;
  }
}

function openImageViewer(url, alt) {
  imageViewerReturnFocus = document.activeElement;
  viewerImage.src = url;
  viewerImage.alt = alt || "Attached receipt";
  viewerImage.style.transform = "scale(1)";
  viewerImage.style.cursor = "zoom-in";
  imageViewer.classList.remove("is-zoomed");
  imageViewer.hidden = false;
  syncOverlayState();
  document.querySelector("#close-image-viewer").focus();
}

function closeImageViewer() {
  imageViewer.hidden = true;
  imageViewer.classList.remove("is-zoomed");
  viewerImage.src = "";
  syncOverlayState();
  if (imageViewerReturnFocus?.isConnected) imageViewerReturnFocus.focus();
  imageViewerReturnFocus = null;
}

document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
document.querySelector("#mobile-more-button").addEventListener("click", openMoreMenu);
document.querySelector("#quick-add-button").addEventListener("click", () => openTransactionModal());
window.addEventListener("scroll", syncTopbarScrollState, { passive: true });
main.addEventListener("scroll", syncTopbarScrollState, { passive: true });
syncTopbarScrollState();
document.querySelector("#close-image-viewer").addEventListener("click", closeImageViewer);
imageViewer.addEventListener("click", event => {
  if (event.target === imageViewer) closeImageViewer();
  else if (event.target === viewerImage) {
    const willZoom = viewerImage.style.transform !== "scale(2)";
    viewerImage.style.transform = willZoom ? "scale(2)" : "scale(1)";
    imageViewer.classList.toggle("is-zoomed", willZoom);
    viewerImage.style.cursor = viewerImage.style.transform === "scale(2)" ? "zoom-out" : "zoom-in";
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "Tab") {
    const activeSurface = !imageViewer.hidden
      ? imageViewer
      : modalRoot.querySelector(".modal");
    if (activeSurface) trapFocus(event, activeSurface);
  }
  if (event.key === "Escape") {
    if (!imageViewer.hidden) closeImageViewer();
    else closeModal();
  }
});
window.addEventListener("beforeunload", revokeObjectURLs);

try {
  db = await openScopeDB();
  await seedScope(db);
  await reload(false);
  renderView();
} catch (error) {
  content.innerHTML = emptyState("!", "Scope could not open local storage", error.message);
}
