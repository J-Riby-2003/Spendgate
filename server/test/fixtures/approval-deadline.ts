// Test-only manipulation of an isolated browser database; never used by production code.
import { db } from '../../src/core/store.js';
const [approvalId] = process.argv.slice(2);
if (!approvalId || !process.env.TOLLKEEP_DATA?.includes('tollkeep-e2e-')) throw new Error('Isolated browser data required');
db.prepare("UPDATE approvals SET expires_at=? WHERE id=? AND status='pending'").run(new Date(Date.now()+4000).toISOString(),approvalId);
db.close();
