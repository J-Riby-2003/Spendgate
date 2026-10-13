import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import type { Request, Response, NextFunction } from 'express';
import { db, SECRET, store, withImmediateTransaction } from './core/store.js';

export type OperatorPrincipal = { kind: 'operator'; operatorId: string; sessionId: string };
export type AgentPrincipal = { kind: 'agent'; agentId: string; credentialId: string };
export type Principal = OperatorPrincipal | AgentPrincipal;
export class AuthError extends Error {
  constructor(message: string, public status = 401) { super(message); }
}
export const authEvents = new EventEmitter();
const scrypt = promisify(scryptCallback);
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const COOKIE = 'sg-session';
function boundedSeconds(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}: expected ${min}–${max} seconds`);
  return n * 1000;
}
export const IDLE_MS = boundedSeconds('SPENDGATE_SESSION_IDLE_SECONDS', 1800, 60, 86400);
export const ABSOLUTE_MS = boundedSeconds('SPENDGATE_SESSION_ABSOLUTE_SECONDS', 28800, 300, 604800);
export function csrfToken(token: string): string { return createHmac('sha256', SECRET).update(`csrf:${token}`).digest('base64url'); }
function equal(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function provisionOperator(username: string, password: string): Promise<{ operatorId: string }> {
  if (!/^[a-zA-Z0-9._-]{2,64}$/.test(username) || password.length < 12 || password.length > 1024) {
    throw new AuthError('Username must be 2–64 letters, digits, dots, dashes or underscores; password must be 12–1024 characters.', 422);
  }
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64) as Buffer;
  return withImmediateTransaction(() => {
    if (db.prepare('SELECT id FROM operators LIMIT 1').get()) throw new AuthError('Operator already provisioned', 409);
    const id = randomUUID();
    db.prepare('INSERT INTO operators VALUES (?, ?, ?, ?)').run(id, username, `scrypt:${salt}:${derived.toString('hex')}`, Date.now());
    audit('operator.provisioned', id);
    return { operatorId: id };
  });
}
function audit(event: string, operatorId: string, agentId: string | null = null, credentialId: string | null = null, replacementId: string | null = null): void {
  db.prepare('INSERT INTO security_audit_events (ts,event,operator_id,agent_id,credential_id,replacement_id) VALUES (?,?,?,?,?,?)')
    .run(Date.now(), event, operatorId, agentId, credentialId, replacementId);
}

export async function login(username: string, password: string, ip: string) {
  // Persisted per-source AND per-account limits prevent restart/IP churn bypass.
  const keys = [hash(`ip:${ip}`), hash(`user:${username}`)];
  const now = Date.now();
  withImmediateTransaction(() => {
    db.prepare('DELETE FROM login_attempts WHERE reset_at <= ?').run(now);
    for (const key of keys) {
      const row = db.prepare('SELECT failures FROM login_attempts WHERE key = ?').get(key);
      if (row && Number(row.failures) >= 5) throw new AuthError('Too many login attempts. Try again in 15 minutes.', 429);
    }
    // Count before KDF so simultaneous attempts cannot bypass the limit.
    for (const key of keys) db.prepare('INSERT INTO login_attempts VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET failures = failures + 1').run(key, now + 900_000);
  });
  const row = db.prepare('SELECT * FROM operators WHERE username = ?').get(username);
  const [, salt, expected] = String(row?.password_hash ?? `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
  const derived = await scrypt(password, salt, 64) as Buffer;
  if (!row || !equal(derived.toString('hex'), expected)) throw new AuthError('Invalid username or password');
  const token = secret(); const id = randomUUID();
  const principal: OperatorPrincipal = { kind: 'operator', operatorId: String(row.id), sessionId: id };
  withImmediateTransaction(() => {
    for (const key of keys) db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
    db.prepare('INSERT INTO operator_sessions VALUES (?,?,?,?,?,?,NULL)').run(id, row.id as string, hash(token), now, now, now + ABSOLUTE_MS);
  });
  return { token, principal, csrfToken: csrfToken(token), expiresAt: now + ABSOLUTE_MS };
}
export function authenticateSession(token: string, touch = true): OperatorPrincipal | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = db.prepare('SELECT s.* FROM operator_sessions s JOIN operators o ON o.id=s.operator_id WHERE token_hash=?').get(hash(token));
  const now = Date.now();
  if (!row || row.revoked_at != null || Number(row.expires_at) <= now || Number(row.last_seen_at) + IDLE_MS <= now) return null;
  if (touch) db.prepare('UPDATE operator_sessions SET last_seen_at=? WHERE id=?').run(now, row.id as string);
  return { kind: 'operator', operatorId: String(row.operator_id), sessionId: String(row.id) };
}
export function logout(token: string): void {
  const row = db.prepare('SELECT id FROM operator_sessions WHERE token_hash=?').get(hash(token));
  db.prepare('UPDATE operator_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').run(Date.now(), hash(token));
  if (row) authEvents.emit('session-revoked', String(row.id));
}

export function listCredentials(agentId: string) {
  return db.prepare('SELECT id,agent_id AS agentId,created_at AS createdAt,revoked_at AS revokedAt FROM agent_credentials WHERE agent_id=? ORDER BY created_at,id').all(agentId);
}
function insertCredential(agentId: string) {
  if (!store.listAgents().some(a => a.agentId === agentId)) throw new AuthError('Unknown agent', 404);
  const id = randomUUID(); const token = secret();
  db.prepare('INSERT INTO agent_credentials VALUES (?,?,?,?,NULL)').run(id, agentId, hash(token), Date.now());
  return { id, agentId, secret: token };
}
export function issueCredential(agentId: string, operatorId: string) {
  return withImmediateTransaction(() => { const c = insertCredential(agentId); audit('credential.created', operatorId, agentId, c.id); return c; });
}
function activeCredential(agentId: string, id: string): void {
  if (!db.prepare('SELECT id FROM agent_credentials WHERE id=? AND agent_id=? AND revoked_at IS NULL').get(id, agentId)) throw new AuthError('Unknown or revoked credential', 404);
}
export function rotateCredential(agentId: string, id: string, operatorId: string) {
  const next = withImmediateTransaction(() => {
    activeCredential(agentId, id);
    const c = insertCredential(agentId);
    db.prepare('UPDATE agent_credentials SET revoked_at=? WHERE id=?').run(Date.now(), id);
    audit('credential.rotated', operatorId, agentId, id, c.id);
    return c;
  });
  authEvents.emit('credential-revoked', id);
  return next;
}
export function revokeCredential(agentId: string, id: string, operatorId: string): void {
  withImmediateTransaction(() => {
    activeCredential(agentId, id);
    db.prepare('UPDATE agent_credentials SET revoked_at=? WHERE id=?').run(Date.now(), id);
    audit('credential.revoked', operatorId, agentId, id);
  });
  authEvents.emit('credential-revoked', id);
}
export function revokeAgentCredentials(agentId: string, operatorId: string): void {
  const ids = withImmediateTransaction(() => {
    const rows = db.prepare('SELECT id FROM agent_credentials WHERE agent_id=? AND revoked_at IS NULL').all(agentId);
    for (const row of rows) {
      db.prepare('UPDATE agent_credentials SET revoked_at=? WHERE id=?').run(Date.now(), row.id as string);
      audit('credential.revoked', operatorId, agentId, String(row.id));
    }
    return rows.map(r => String(r.id));
  });
  for (const id of ids) authEvents.emit('credential-revoked', id);
}
export function assertAgentActive(principal: AgentPrincipal): void {
  if (!db.prepare('SELECT c.id FROM agent_credentials c JOIN agents a ON a.agent_id=c.agent_id WHERE c.id=? AND c.agent_id=? AND c.revoked_at IS NULL').get(principal.credentialId, principal.agentId)) throw new AuthError('Unauthorized');
}
export function authenticateAgent(token: string): AgentPrincipal | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = db.prepare('SELECT c.id,c.agent_id FROM agent_credentials c JOIN agents a ON a.agent_id=c.agent_id WHERE c.token_hash=? AND c.revoked_at IS NULL').get(hash(token));
  return row ? { kind: 'agent', agentId: String(row.agent_id), credentialId: String(row.id) } : null;
}
export function sessionToken(req: Pick<Request, 'headers'>): string {
  return (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
}
export function cookieOptions() { return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/', maxAge: ABSOLUTE_MS }; }
export const SESSION_COOKIE = COOKIE;
export function requireOperator(req: Request, res: Response, next: NextFunction): void {
  const principal = authenticateSession(sessionToken(req), false);
  if (!principal) { res.status(401).json({ error: 'Unauthorized' }); return; }
  res.locals.principal = principal;
  next();
}
export function requireAgent(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const principal = authenticateAgent(header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!principal) { res.status(401).json({ error: 'Unauthorized' }); return; }
  res.locals.principal = principal;
  next();
}
export function allowedOrigin(req: Pick<Request, 'headers'>): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return false;
  const configured = process.env.SPENDGATE_PUBLIC_BASE_URL;
  if (configured) { try { return origin === new URL(configured).origin; } catch { return false; } }
  if (process.env.NODE_ENV === 'production') return false;
  return origin === `http://${req.headers.host}`;
}
export function requireOrigin(req: Request, res: Response, next: NextFunction): void {
  if (!allowedOrigin(req)) { res.status(403).json({ error: 'Invalid origin' }); return; }
  next();
}
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }
  if (!allowedOrigin(req) || !equal(String(req.headers['x-csrf-token'] ?? ''), csrfToken(sessionToken(req)))) {
    res.status(403).json({ error: 'Invalid CSRF token or origin' }); return;
  }
  next();
}
