import { createBudgetStore } from './budget.js';
import { db } from './store.js';
export const budget = createBudgetStore(db);
