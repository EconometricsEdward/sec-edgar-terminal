import { AsyncLocalStorage } from 'node:async_hooks';

// A request-local allowance supplements the shared SEC rate gate. It never
// grants permission to bypass that gate and cannot affect unrelated visitors.
const context = new AsyncLocalStorage();
export function runWithSecRequestBudget(limit, callback) {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000 || typeof callback !== 'function')
    throw new TypeError('Invalid SEC request budget.');
  const parent = context.getStore() || null;
  // Nested workers must see their effective remaining allowance. Otherwise a
  // parent limit can look like a source outage to a child with a larger limit.
  for (let ancestor = parent; ancestor; ancestor = ancestor.parent) limit = Math.min(limit, Math.max(0, ancestor.limit - ancestor.used));
  const budget = { limit, used: 0, parent };
  return context.run(budget, () => callback(budget));
}
export function takeSecRequestBudget() {
  const budgets = [];
  for (let budget = context.getStore(); budget; budget = budget.parent) {
    if (budget.used >= budget.limit) return false;
    budgets.push(budget);
  }
  for (const budget of budgets) budget.used++;
  return true;
}
