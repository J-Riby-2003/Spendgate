import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
it('waits for an existing DELETE-mode writer before enabling WAL and migrating', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tollkeep-startup-lock-'));
  const db = new DatabaseSync(join(dir, 'tollkeep.db'));
  db.exec('CREATE TABLE existing (id INTEGER); BEGIN EXCLUSIVE; INSERT INTO existing VALUES (1)');
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/startup-worker.ts'], { env: { ...process.env, TOLLKEEP_DATA: dir }, stdio: ['ignore','pipe','pipe'] });
  let output = '', diagnostic = '';
  let release: ReturnType<typeof setTimeout> | undefined;
  child.stdout.on('data', chunk => {
    output += String(chunk);
    if (output.includes('opening\n') && !release) release = setTimeout(() => db.exec('COMMIT'), 250);
  });
  child.stderr.on('data', chunk => { diagnostic += String(chunk); });
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    expect(code, diagnostic).toBe(0);
    const result = JSON.parse(output.trim().split('\n').at(-1)!);
    expect(result.journal.journal_mode).toBe('wal');
    expect(result.timeout.timeout).toBe(10000);
    expect(db.prepare('SELECT id FROM existing').get()?.id).toBe(1);
  } finally {
    clearTimeout(release);
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
