// Loads .spendgate/env (KEY=VALUE lines, # comments) into process.env so the
// server can be configured without exporting vars in every shell. Real
// environment variables always win. Imported FIRST by index.ts, before any
// module reads process.env.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = process.env.SPENDGATE_DATA ?? join(process.cwd(), '..', '.spendgate');
const ENV_FILE = join(DATA_DIR, 'env');

if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
