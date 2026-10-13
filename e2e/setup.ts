import { execFileSync } from 'node:child_process';
export default async function setup() {
  execFileSync(process.execPath, ['--import', 'tsx', 'server/src/provision-operator.ts', 'test-operator'], {
    cwd: process.cwd(), env: process.env, input: 'isolated test operator password\n', stdio: ['pipe', 'pipe', 'pipe'],
  });
}
