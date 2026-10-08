// Seed agents + policies on first run (idempotent).
import { store } from './core/store.js';
import type { Policy } from './core/types.js';

const gbp = (pounds: number) => pounds * 100;
const usd = (dollars: number) => dollars * 100;

const SEED: { agentId: string; displayName: string; currency: string; policy: Omit<Policy, 'agentId'> }[] = [
  {
    agentId: 'procurement-02',
    displayName: 'PROC-02 — Procurement agent',
    currency: 'GBP',
    policy: {
      maxPerTxn: gbp(50),
      dailyBudget: gbp(500),
      approvalThreshold: gbp(200),
      allowedVendors: '*',
      blockedVendors: ['bobs-discount-emporium'],
      newVendorRequiresApproval: true,
      allowedDays: [1, 2, 3, 4, 5],
      allowedWindow: { start: '08:00', end: '20:00' },
    },
  },
  {
    agentId: 'crawler-01',
    displayName: 'CRAWLER — Data crawler',
    currency: 'USD',
    policy: {
      maxPerTxn: usd(5),
      dailyBudget: usd(25),
      approvalThreshold: usd(10),
      allowedVendors: '*',
      blockedVendors: [],
      newVendorRequiresApproval: true,
      allowedDays: '*',
      allowedWindow: null,
    },
  },
  {
    agentId: 'finance-01',
    displayName: 'FINANCE — Finance agent',
    currency: 'GBP',
    policy: {
      maxPerTxn: gbp(5000),
      dailyBudget: gbp(50000),
      approvalThreshold: gbp(20000),
      allowedVendors: '*',
      blockedVendors: [],
      newVendorRequiresApproval: false,
      allowedDays: '*',
      allowedWindow: null,
    },
  },
];

export function seed(): void {
  for (const s of SEED) {
    store.upsertAgent(s.agentId, s.displayName, s.currency);
    if (!store.getPolicy(s.agentId)) {
      store.upsertPolicy({ agentId: s.agentId, ...s.policy });
    }
  }
}
