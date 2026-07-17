import { activeTransactions } from "./db.js";

export function money(value, currency = "USD") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(value || 0));
}

export function currentMonthRange(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return { start, end };
}

export function inRange(value, start, end) {
  const date = new Date(value);
  return date >= start && date <= end;
}

export function calculateSnapshot(state, now = new Date()) {
  const { start, end } = currentMonthRange(now);
  const transactions = activeTransactions(state.transactions || []);
  const monthly = transactions.filter(item => inRange(item.date, start, end));
  const income = monthly.filter(item => item.type === "income").reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const expenses = monthly.filter(item => item.type === "expense").reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const balances = (state.accounts || []).reduce((sum, account) => sum + Number(account.balance || 0), 0);
  const availableBalance = balances || income - expenses;

  const categoryMap = new Map((state.categories || []).map(category => [category.id, category]));
  const spendingByCategory = new Map();
  for (const transaction of monthly.filter(item => item.type === "expense")) {
    const key = transaction.categoryID || transaction.categoryNameSnapshot || "uncategorized";
    spendingByCategory.set(key, (spendingByCategory.get(key) || 0) + Number(transaction.amount || 0));
  }

  const budgetRows = (state.budgets || []).map(budget => {
    const category = categoryMap.get(budget.categoryID);
    const spent = spendingByCategory.get(budget.categoryID) || 0;
    const amount = Number(budget.monthlyAmount || 0);
    return {
      ...budget,
      categoryName: category?.name || "Uncategorized",
      categoryColor: category?.colorHex || "#64748b",
      spent,
      remaining: amount - spent,
      percent: amount > 0 ? spent / amount : 0
    };
  });

  const upcomingBills = (state.events || [])
    .filter(event => event.isActive !== false && event.estimatedCost > 0 && new Date(event.nextDate) >= now)
    .map(event => ({ name: event.name, amount: Number(event.estimatedCost), dueDate: event.nextDate, categoryID: event.categoryID }))
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  const upcomingBillsTotal = upcomingBills.reduce((sum, bill) => sum + bill.amount, 0);
  const remainingSavings = (state.savingsGoals || []).reduce((sum, goal) => {
    return sum + Math.max(0, Number(goal.targetAmount || 0) - Number(goal.savedAmount || 0));
  }, 0);
  const totalBudget = budgetRows.reduce((sum, budget) => sum + Number(budget.monthlyAmount || 0), 0);
  const remainingBudget = totalBudget > 0 ? totalBudget - expenses : income - expenses;
  const flexibleMoneyAfterBills = Math.max(0, Math.min(availableBalance, remainingBudget) - upcomingBillsTotal - remainingSavings);

  const topCategories = [...spendingByCategory.entries()]
    .map(([id, amount]) => ({
      id,
      name: categoryMap.get(id)?.name || String(id),
      color: categoryMap.get(id)?.colorHex || "#64748b",
      amount
    }))
    .sort((a, b) => b.amount - a.amount);

  return {
    start,
    end,
    transactions,
    monthly,
    income,
    expenses,
    net: income - expenses,
    availableBalance,
    totalBudget,
    remainingBudget,
    budgetRows,
    upcomingBills,
    upcomingBillsTotal,
    remainingSavings,
    flexibleMoneyAfterBills,
    topCategories,
    recentTransactions: [...transactions].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 8)
  };
}

export function extractAmount(question) {
  const match = String(question).replaceAll(",", "").match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  return match ? Number(match[1]) : null;
}

export function detectIntent(question) {
  const lower = question.toLowerCase();
  if (/can i|afford|should i buy|purchase|spend \$/.test(lower)) return "affordability";
  if (/bill|due|rent/.test(lower)) return "bills";
  if (/cut back|save more|reduce/.test(lower)) return "cutback";
  if (/overspend|running low|why.*low/.test(lower)) return "overspending";
  if (/last|purchase at|spent at/.test(lower)) return "lookup";
  if (/save|goal/.test(lower)) return "savings";
  if (/how much.*(food|gas|dining|shopping|business|grocer)|spent on/.test(lower)) return "category";
  return "status";
}

export function assistantAnswer(question, state, now = new Date()) {
  const snapshot = calculateSnapshot(state, now);
  const intent = detectIntent(question);
  const amount = extractAmount(question);
  const missing = [];
  if (!(state.transactions || []).length) missing.push("recent transactions");
  if (!(state.budgets || []).length) missing.push("category budgets");
  if (!(state.events || []).some(event => event.isActive && event.estimatedCost > 0)) missing.push("upcoming bills");

  if (intent === "affordability") {
    if (amount == null) return "What is the purchase amount? I need it to compare the purchase with your flexible money, bills, and budget.";
    const after = snapshot.flexibleMoneyAfterBills - amount;
    const decision = amount <= snapshot.flexibleMoneyAfterBills * 0.6 ? "Yes" : amount <= snapshot.flexibleMoneyAfterBills ? "Caution" : "No";
    const qualifier = missing.length ? ` This is a rough estimate because Scope is missing ${missing.join(" and ")}.` : "";
    if (decision === "Yes") {
      return `Yes — ${money(amount)} fits within your ${money(snapshot.flexibleMoneyAfterBills)} flexible amount after known bills and goals. You would keep about ${money(Math.max(0, after))} available.${qualifier}`;
    }
    if (decision === "Caution") {
      return `Caution — you can cover ${money(amount)}, but it would leave only ${money(Math.max(0, after))} flexible. A safer limit is about ${money(snapshot.flexibleMoneyAfterBills * 0.5)}.${qualifier}`;
    }
    return `No — ${money(amount)} is above your ${money(snapshot.flexibleMoneyAfterBills)} flexible amount after known bills and goals. Wait for more income or reduce the purchase by ${money(amount - snapshot.flexibleMoneyAfterBills)}.${qualifier}`;
  }

  if (intent === "bills") {
    if (!snapshot.upcomingBills.length) return "No upcoming bills are entered. Add recurring bills under Events so Scope can include them in affordability checks.";
    const lines = snapshot.upcomingBills.slice(0, 4).map(bill => `${bill.name} ${money(bill.amount)} on ${new Date(bill.dueDate).toLocaleDateString()}`);
    return `You have ${money(snapshot.upcomingBillsTotal)} in known upcoming bills: ${lines.join("; ")}.`;
  }

  if (intent === "category") {
    const lower = question.toLowerCase();
    const match = snapshot.topCategories.find(category => lower.includes(category.name.toLowerCase()) || category.name.toLowerCase().split(" ").some(word => word.length > 3 && lower.includes(word)));
    if (!match) return "I could not match that category. Try the exact category name shown in Budget.";
    const budget = snapshot.budgetRows.find(item => item.categoryName === match.name);
    return budget
      ? `You spent ${money(match.amount)} on ${match.name} this month and have ${money(budget.remaining)} left in its ${money(budget.monthlyAmount)} budget.`
      : `You spent ${money(match.amount)} on ${match.name} this month. No category budget is set yet.`;
  }

  if (intent === "lookup") {
    const terms = question.toLowerCase().split(/\s+/).filter(term => term.length > 3);
    const match = snapshot.transactions.find(transaction => terms.some(term => String(transaction.merchant || "").toLowerCase().includes(term)));
    return match
      ? `Your latest matching transaction was ${money(match.amount)} at ${match.merchant} on ${new Date(match.date).toLocaleDateString()}.`
      : "I could not find a matching active transaction.";
  }

  if (intent === "cutback" || intent === "overspending") {
    if (!snapshot.topCategories.length) return "There is not enough spending data yet to identify a useful cutback.";
    const top = snapshot.topCategories.slice(0, 3);
    const over = snapshot.budgetRows.filter(item => item.remaining < 0);
    const lead = over.length
      ? `${over[0].categoryName} is over budget by ${money(Math.abs(over[0].remaining))}.`
      : `${top[0].name} is your largest category at ${money(top[0].amount)}.`;
    return `${lead} Review ${top.map(item => item.name).join(", ")} first; reducing the largest one by 10% would save about ${money(top[0].amount * 0.1)} this month.`;
  }

  if (intent === "savings") {
    if (!(state.savingsGoals || []).length) return `No savings goal is entered. Your current flexible amount after known bills is ${money(snapshot.flexibleMoneyAfterBills)}.`;
    return `You have ${money(snapshot.remainingSavings)} remaining across savings goals and ${money(snapshot.flexibleMoneyAfterBills)} flexible after known bills and goals.`;
  }

  const overspent = snapshot.budgetRows.filter(item => item.percent > 1);
  const pace = overspent.length ? `${overspent.length} categor${overspent.length === 1 ? "y is" : "ies are"} over budget.` : "No category is currently over budget.";
  return `You received ${money(snapshot.income)} and spent ${money(snapshot.expenses)} this month, leaving ${money(snapshot.net)} net. ${pace} Your flexible amount after known bills and goals is ${money(snapshot.flexibleMoneyAfterBills)}.`;
}

