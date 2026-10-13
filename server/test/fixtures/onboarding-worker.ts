// Independent process: inputs contain IDs and draft data only, never credential secrets.
import { db } from '../../src/core/store.js';
import { ownedJourney, journeyView } from '../../src/core/onboarding-store.js';
import { registerAgent } from '../../src/core/agents.js';
import { issueCredential } from '../../src/auth.js';
let source = '';
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source);
if (input.action === 'register') process.stdout.write(JSON.stringify(registerAgent(input.setup, input.operatorId)));
if (input.action === 'credential') {
  const result = issueCredential(input.agentId, input.operatorId, input.id);
  process.stdout.write(JSON.stringify({ id: result.id, delivered: !!result.secret }));
}
if (input.action === 'read') process.stdout.write(JSON.stringify(journeyView(ownedJourney(input.id, input.operatorId))));
db.close();
