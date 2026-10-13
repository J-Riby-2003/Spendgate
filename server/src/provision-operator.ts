import './config.js';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { provisionOperator } from './auth.js';
// Password is read from stdin, never argv, environment, or logs.
let password = '';
if (process.stdin.isTTY) {
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const reader = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write('Operator password (hidden): ');
  password = await reader.question('');
  reader.close(); process.stderr.write('\n');
} else {
  for await (const chunk of process.stdin) {
    password += chunk.toString();
    if (password.length > 1026) { console.error('Password exceeds 1024 characters'); process.exit(1); }
  }
}
try {
  await provisionOperator(process.argv[2] ?? 'operator', password.replace(/\r?\n$/, ''));
  console.log('Operator provisioned. Sign in through the console.');
} catch {
  console.error('Provisioning failed. Use a valid username and a 12–1024 character password; only one initial operator is supported.');
  process.exitCode = 1;
}
