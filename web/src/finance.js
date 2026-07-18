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

