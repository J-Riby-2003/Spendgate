import type { Policy } from './types.js';
export interface PolicyRevision {
  agentId: string; version: number; changedAt: string; changedBy: string;
  source: 'operator' | 'migration' | 'seed' | 'system';
  before: Policy | null; after: Policy;
}
export class PolicyConflict extends Error {
  readonly status = 409;
  constructor() { super('Policy changed. Reload the current policy before comparing or saving again.'); }
}
