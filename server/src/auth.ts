// Console auth: one bearer token for all mutating endpoints + MCP.
// Token resolution order: SPENDGATE_TOKEN env -> .spendgate/console.token (auto-generated, 0600).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const DATA_DIR = process.env.SPENDGATE_DATA ?? join(process.cwd(), '..', '.spendgate');
const TOKEN_FILE = join(DATA_DIR, 'console.token');

function loadOrCreateToken(): string {
  if (process.env.SPENDGATE_TOKEN) return process.env.SPENDGATE_TOKEN.trim();
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim();
  const token = randomBytes(24).toString('base64url');
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

export const CONSOLE_TOKEN = loadOrCreateToken();
export const CONSOLE_TOKEN_FILE = TOKEN_FILE;

function tokenMatches(provided: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(CONSOLE_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Express middleware: 401 unless the request carries the console bearer token. */
export function requireToken(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (provided && tokenMatches(provided)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
