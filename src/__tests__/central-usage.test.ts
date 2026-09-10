import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Server } from 'node:http';
import { createCentralServer } from '../central/server.js';
import { digest, readAuth, type AuthConfig, type Snapshot } from '../central/contract.js';
import { migrate, Store } from '../central/store.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

describe('central usage: real HTTP and persistent SQLite, synthetic data only', () => {
  let dir: string, db: string, auth: string, origin: string, server: Server, config: AuthConfig;
  let admin: string, a: string, b: string;
  const sql = path.resolve('src/central/migrations/001-initial.sql');
  const save = () => writeFileSync(auth, JSON.stringify(config), { mode: 0o600 });
  const token = () => randomBytes(32).toString('base64url');
  const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
    schemaVersion: 1, eventId: randomUUID(), memberId: 'member-a', installationId: 'install-a', project: 'project-a', sessionId: randomUUID(),
    firstStopAt: '2026-01-01T00:00:00.000Z', observedAt: '2026-01-01T00:01:00.000Z', sequence: 1, prompts: 2,
    tokens: { input: 100, output: 20, cacheRead: 50, cacheCreation: null }, producerVersion: 'synthetic-1', ...overrides,
  });
  const post = (value: unknown, bearer = a) => fetch(origin + '/api/usage/report', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` }, body: JSON.stringify(value) });
  const summary = (query = '') => fetch(origin + '/api/usage/summary?from=2026-01-01&to=2026-01-31' + query, { headers: { Authorization: `Bearer ${admin}` } });
  async function start() {
    server = createCentralServer({ db, auth, origin: origin ?? 'http://127.0.0.1' });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address === 'object' && address) origin = `http://127.0.0.1:${address.port}`;
  }
  async function close() { if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'teamai-central-test-')); db = path.join(dir, 'usage.sqlite'); auth = path.join(dir, 'auth.json');
    admin = token(); a = token(); b = token();
    config = { schemaVersion: 1, dataset: 'synthetic', admins: [{ id: 'admin', tokenHash: digest(admin), expiresAt: '2099-01-01T00:00:00.000Z', revoked: false }], installations: [
      { memberId: 'member-a', installationId: 'install-a', tokenHash: digest(a), projects: ['project-a'], expiresAt: '2099-01-01T00:00:00.000Z', revoked: false },
      { memberId: 'member-b', installationId: 'install-b', tokenHash: digest(b), projects: ['project-b'], expiresAt: '2099-01-01T00:00:00.000Z', revoked: false },
    ] }; save(); migrate(db, sql, 'synthetic'); origin = 'http://127.0.0.1'; await start();
  });
  afterEach(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });

  it('persists two members/projects, treats unknown separately and filters dates', async () => {
    expect((await post(snapshot())).status).toBe(200);
    expect((await post(snapshot({ memberId: 'member-b', installationId: 'install-b', project: 'project-b', tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 } }), b)).status).toBe(200);
    const result = await (await summary()).json();
    expect(result).toMatchObject({ dataset: 'synthetic', sessions: 2, tokens: { input: 110, output: 25, cacheRead: 50, cacheCreation: 0 }, unknown: { cacheCreation: 1 }, timezone: 'UTC' });
    expect(result.members).toHaveLength(2); expect(result.projects).toHaveLength(2); expect(result.latestReport).toMatch(/Z$/);
    expect((await (await summary('&member=member-a&project=project-a')).json()).sessions).toBe(1);
    expect((await (await summary('&member=member-a&project=project-b')).json()).sessions).toBe(0);
  });
  it('retries and out-of-order events cannot inflate cumulative counters', async () => {
    const first = snapshot(), next = { ...first, eventId: randomUUID(), sequence: 2, tokens: { ...first.tokens, input: 150 } };
    expect((await post(next)).status).toBe(200);
    expect(await (await post(first)).json()).toEqual({ ok: true, result: 'stale' });
    expect(await (await post(first)).json()).toEqual({ ok: true, result: 'duplicate' });
    expect(await (await post(next)).json()).toEqual({ ok: true, result: 'duplicate' });
    expect((await (await summary()).json()).tokens.input).toBe(150);
  });
  it('serializes concurrent retries transactionally', async () => {
    const value = snapshot(); const results = await Promise.all(Array.from({ length: 12 }, () => post(value)));
    expect(results.every(r => r.status === 200)).toBe(true);
    expect((await (await summary()).json()).sessions).toBe(1);
  });
  it('rejects reused event ids, revisions, changed date and decreasing measured counters', async () => {
    const first = snapshot(); await post(first);
    expect((await post({ ...first, prompts: 3 })).status).toBe(409);
    expect((await post({ ...first, eventId: randomUUID() })).status).toBe(409);
    expect((await post({ ...first, eventId: randomUUID(), sequence: 2, firstStopAt: '2026-01-02T00:00:00.000Z', observedAt: '2026-01-02T00:01:00.000Z' })).status).toBe(409);
    expect((await post({ ...first, eventId: randomUUID(), sequence: 2, tokens: { ...first.tokens, input: null } })).status).toBe(409);
    expect((await post({ ...first, eventId: randomUUID(), sequence: 2, prompts: 1 })).status).toBe(409);
  });
  it('rejects unauthenticated, invalid, revoked, expired, forged and admin-as-reporter credentials', async () => {
    for (const bearer of ['', token(), admin]) expect((await post(snapshot(), bearer)).status).toBe(401);
    for (const value of [{ memberId: 'member-b' }, { installationId: 'install-b' }, { project: 'project-b' }]) expect((await post(snapshot(value))).status).toBe(400);
    config.installations[0].revoked = true; save(); expect((await post(snapshot())).status).toBe(401);
    config.installations[0].revoked = false; config.installations[0].expiresAt = '2000-01-01T00:00:00.000Z'; save(); expect((await post(snapshot())).status).toBe(401);
  });
  it('rejects content-bearing fields and malformed counters before storage', async () => {
    for (const extra of [{ prompt: 'PRIVATE_CANARY' }, { promptSummary: 'PRIVATE_CANARY' }, { transcriptPath: '/PRIVATE_CANARY' }, { tools: { args: 'PRIVATE_CANARY' } }]) expect((await post({ ...snapshot(), ...extra })).status).toBe(400);
    expect((await post(snapshot({ tokens: { input: -1, output: 0, cacheRead: 0, cacheCreation: 0 } }))).status).toBe(400);
    expect((await post(snapshot({ observedAt: '2099-01-01T00:00:00.000Z' }))).status).toBe(400);
    await post(snapshot()); await close();
    const bytes = readFileSync(db).toString('utf8');
    for (const forbidden of ['PRIVATE_CANARY', admin, a, b, 'tokenHash', 'promptSummary', 'transcriptPath']) expect(bytes).not.toContain(forbidden);
  });
  it('protects HTML, options, summary and cross-origin requests', async () => {
    for (const route of ['/', '/api/usage/options', '/api/usage/summary']) {
      expect((await fetch(origin + route)).status).toBe(401);
      expect((await fetch(origin + route, { headers: { Authorization: `Bearer ${a}` } })).status).toBe(401);
    }
    expect((await fetch(origin + '/api/usage/options', { headers: { Authorization: `Bearer ${admin}`, Origin: 'https://untrusted.example' } })).status).toBe(403);
    config.admins[0].revoked = true; save(); expect((await summary()).status).toBe(401);
  });
  it('validates filter duplicates, dates and range boundaries without returning stale totals', async () => {
    expect((await summary('&from=2026-01-02')).status).toBe(400);
    expect((await summary('&includeDeleted=true')).status).toBe(400);
    expect((await summary('&member=/private/path')).status).toBe(400);
    for (const dates of ['from=2026-02-30&to=2026-03-01', 'from=2026-02-01&to=2026-01-01', 'from=2020-01-01&to=2026-01-01']) {
      expect((await fetch(origin + '/api/usage/summary?' + dates, { headers: { Authorization: `Bearer ${admin}` } })).status).toBe(400);
    }
  });
  it('retains committed data across server recreation and explicit migration retry', async () => {
    const value = snapshot(); await post(value); await close(); migrate(db, sql, 'synthetic'); await start();
    expect((await (await summary()).json()).sessions).toBe(1);
    expect(await (await post(value)).json()).toEqual({ ok: true, result: 'duplicate' });
  });
  it('never initializes at serve and never mixes synthetic/production volumes', async () => {
    expect(() => new Store(path.join(dir, 'absent.sqlite'), 'synthetic')).toThrow('explicit migration');
    expect(() => new Store(db, 'production')).toThrow('Dataset mismatch');
    expect(() => migrate(db, sql, 'production')).toThrow('Dataset mismatch');
  });
  it('default summaries hide soft-deleted rows and keep physical audit evidence', async () => {
    await post(snapshot());
    const audit = new DatabaseSync(db);
    // Isolated fixture setup only: no public business deletion or restoration endpoint exists.
    audit.prepare('UPDATE usage_snapshots SET del_status = 1 WHERE del_status = 0').run();
    expect((await (await summary()).json()).sessions).toBe(0);
    expect(audit.prepare('SELECT COUNT(*) AS n FROM usage_snapshots WHERE del_status = 1').get()?.n).toBe(1); audit.close();
  });
  it('validates configuration identity uniqueness', () => {
    config.installations[1].installationId = config.installations[0].installationId; save();
    expect(() => readAuth(auth)).toThrow('Duplicate');
  });
  it('serves a Chinese protected dashboard and explicit login error', async () => {
    const page = await fetch(origin + '/', { headers: { Authorization: `Bearer ${admin}` } });
    expect(page.status).toBe(200); expect(await page.text()).toContain('团队用量总览');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect((await fetch(origin + '/login')).status).toBe(200);
  });
  it('returns a bounded error for oversized bodies without persisting content', async () => {
    expect((await post({ padding: 'x'.repeat(9000) })).status).toBe(413);
    expect((await (await summary()).json()).sessions).toBe(0);
  });
});
