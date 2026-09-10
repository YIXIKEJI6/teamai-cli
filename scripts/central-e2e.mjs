// Real process/container HTTP acceptance. Every identity and session is synthetic.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
const mode = process.argv[2];
assert(['local', 'docker'].includes(mode), 'Choose local or docker');
const image = process.env.TEAMAI_CENTRAL_IMAGE;
if (mode === 'docker') assert(image, 'TEAMAI_CENTRAL_IMAGE is required');
const dir = mkdtempSync(path.join(os.tmpdir(), 'teamai-central-e2e-'));
const configDir = path.join(dir, 'auth'); mkdirSync(configDir); chmodSync(configDir, 0o755);
const admin = randomBytes(32).toString('base64url'), a = randomBytes(32).toString('base64url'), b = randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const auth = { schemaVersion: 1, dataset: 'synthetic', admins: [{ id: 'synthetic-admin', tokenHash: hash(admin), expiresAt: '2099-01-01T00:00:00.000Z', revoked: false }], installations: [
  { memberId: 'synthetic-a', installationId: 'installation-a', tokenHash: hash(a), projects: ['project-alpha'], expiresAt: '2099-01-01T00:00:00.000Z', revoked: false },
  { memberId: 'synthetic-b', installationId: 'installation-b', tokenHash: hash(b), projects: ['project-beta'], expiresAt: '2099-01-01T00:00:00.000Z', revoked: false },
] };
const saveAuth = () => { writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify(auth)); chmodSync(path.join(configDir, 'auth.json'), 0o444); };
saveAuth();
const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`, db = path.join(dir, 'usage.sqlite');
const id = `teamai-e2e-${randomUUID()}`, volume = `${id}-data`, logFile = path.join(dir, 'server.log');
const env = { ...process.env, TEAMAI_CENTRAL_AUTH_FILE: path.join(configDir, 'auth.json'), TEAMAI_CENTRAL_DB: db, TEAMAI_CENTRAL_ORIGIN: origin, TEAMAI_CENTRAL_PORT: String(port), TEAMAI_CENTRAL_HOST: '127.0.0.1' };
const dockerArgs = ['--read-only', '--user', '1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--mount', `source=${volume},target=/data`, '--mount', `type=bind,source=${configDir},target=/run/teamai,readonly`, '-e', 'TEAMAI_CENTRAL_AUTH_FILE=/run/teamai/auth.json', '-e', `TEAMAI_CENTRAL_ORIGIN=${origin}`];
let processHandle, started = false, volumeCreated = false;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start() {
  if (mode === 'docker') { docker('run', '-d', '--name', id, ...dockerArgs, '-p', `127.0.0.1:${port}:3722`, image, 'serve'); started = true; }
  else { const fd = openSync(logFile, 'a', 0o600); processHandle = spawn(process.execPath, ['dist/central.js', 'serve'], { env, stdio: ['ignore', fd, fd] }); closeSync(fd); started = true; }
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(origin + '/healthz', { signal: AbortSignal.timeout(500) })).status === 200) return; } catch {}
    await wait(100);
  }
  throw new Error('Service health did not become ready');
}
async function stop() {
  if (!started) return;
  if (mode === 'docker') { writeFileSync(logFile, docker('logs', id), { flag: 'a' }); docker('stop', '--time', '5', id); docker('rm', id); }
  else { const child = processHandle; const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; }
  started = false;
}
const date = new Date().toISOString().slice(0, 10), firstStopAt = `${date}T00:00:00.000Z`;
const snap = (memberId, installationId, project, input) => ({ schemaVersion: 1, eventId: randomUUID(), memberId, installationId, project, sessionId: randomUUID(), firstStopAt, observedAt: new Date().toISOString(), sequence: 1, prompts: 2, tokens: { input, output: 20, cacheRead: 30, cacheCreation: null }, producerVersion: 'synthetic-e2e-1' });
const send = (value, token) => fetch(origin + '/api/usage/report', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(value) });
const get = async (extra = '') => { const r = await fetch(origin + `/api/usage/summary?from=${date}&to=${date}` + extra, { headers: { Authorization: `Bearer ${admin}` } }); assert.equal(r.status, 200); return r.json(); };
try {
  if (mode === 'docker') {
    docker('volume', 'create', volume); volumeCreated = true;
    assert.equal(docker('image', 'inspect', image, '--format', '{{.Config.User}}').trim(), '1000:1000');
    docker('run', '--rm', ...dockerArgs, image, 'migrate');
  } else execFileSync(process.execPath, ['dist/central.js', 'migrate'], { env, stdio: 'pipe' });
  await start();
  if (mode === 'docker') assert.equal(docker('exec', id, 'id', '-u').trim(), '1000');
  for (const route of ['/', '/api/usage/options', '/api/usage/summary']) assert.equal((await fetch(origin + route)).status, 401);
  const sa = snap('synthetic-a', 'installation-a', 'project-alpha', 100), sb = snap('synthetic-b', 'installation-b', 'project-beta', 200);
  const newer = { ...sa, eventId: randomUUID(), sequence: 2, tokens: { ...sa.tokens, input: 150 } };
  assert.equal((await send(newer, a)).status, 200); assert.equal((await send(sb, b)).status, 200);
  assert.equal((await (await send(sa, a)).json()).result, 'stale');
  assert.equal((await (await send(newer, a)).json()).result, 'duplicate');
  for (const value of [{ ...sa, memberId: 'synthetic-b' }, { ...sa, project: 'project-beta' }, { ...sa, promptSummary: 'PRIVATE_CONTENT_CANARY' }]) assert.equal((await send(value, a)).status, 400);
  assert.equal((await send(sa, admin)).status, 401);
  assert.equal((await fetch(origin + '/api/usage/summary', { headers: { Authorization: `Bearer ${a}` } })).status, 401);
  auth.installations[0].revoked = true; chmodSync(path.join(configDir, 'auth.json'), 0o644); saveAuth(); assert.equal((await send(sa, a)).status, 401);
  auth.installations[0].revoked = false; auth.installations[0].expiresAt = '2000-01-01T00:00:00.000Z'; chmodSync(path.join(configDir, 'auth.json'), 0o644); saveAuth(); assert.equal((await send(sa, a)).status, 401);
  auth.installations[0].expiresAt = '2099-01-01T00:00:00.000Z'; chmodSync(path.join(configDir, 'auth.json'), 0o644); saveAuth();
  const login = await fetch(origin + '/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: 'synthetic-admin', token: admin }), redirect: 'manual' });
  assert.equal(login.status, 303); const cookie = login.headers.get('set-cookie'); assert.match(cookie, /HttpOnly; SameSite=Strict/);
  const page = await fetch(origin + '/', { headers: { Cookie: cookie.split(';')[0] } }); assert.equal(page.status, 200); assert.match(await page.text(), /团队用量总览/);
  auth.admins[0].revoked = true; chmodSync(path.join(configDir, 'auth.json'), 0o644); saveAuth(); assert.equal((await fetch(origin + '/', { headers: { Cookie: cookie.split(';')[0] } })).status, 401);
  auth.admins[0].revoked = false; chmodSync(path.join(configDir, 'auth.json'), 0o644); saveAuth();
  const before = await get(); assert.equal(before.sessions, 2); assert.equal(before.tokens.input, 350); assert.equal(before.unknown.cacheCreation, 2);
  assert.equal((await get('&member=synthetic-a&project=project-alpha')).sessions, 1);
  assert.equal((await get('&member=synthetic-a&project=project-beta')).sessions, 0);
  const dateRangeBoundaries = [];
  for (const [to, expectedStatus] of [['2026-01-01', 200], ['2026-01-02', 400]]) {
    const response = await fetch(origin + '/api/usage/summary?' + new URLSearchParams({ from: '2025-01-01', to }), { headers: { Authorization: `Bearer ${admin}` } });
    dateRangeBoundaries.push({ from: '2025-01-01', to, status: response.status });
    assert.equal(response.status, expectedStatus, `Inclusive UTC range through ${to}`);
    await response.arrayBuffer();
  }
  await stop(); await start();
  const after = await get(); assert.deepEqual(after, before); assert.equal((await (await send(newer, a)).json()).result, 'duplicate');
  await stop();
  let stored;
  if (mode === 'docker') stored = docker('run', '--rm', '--read-only', '--user', '1000:1000', '--mount', `source=${volume},target=/data,readonly`, '--entrypoint', 'node', image, '-e', "const fs=require('node:fs');process.stdout.write(fs.readFileSync('/data/usage.sqlite').toString('base64'));");
  else stored = readFileSync(db).toString('base64');
  const storage = Buffer.from(stored, 'base64').toString('utf8'), logs = readFileSync(logFile, 'utf8');
  for (const forbidden of [admin, a, b, 'PRIVATE_CONTENT_CANARY', 'promptSummary', 'tokenHash']) { assert(!storage.includes(forbidden)); assert(!logs.includes(forbidden)); }
  const evidence = { mode, dataset: 'synthetic', checkedAt: new Date().toISOString(), image: mode === 'docker' ? image : null, uid: mode === 'docker' ? 1000 : process.getuid?.(), checks: ['two-members-two-projects', 'unknown-buckets', 'filters-and-empty', 'inclusive-date-range-boundary', 'replay-and-ordering', 'invalid-forged-revoked-expired-auth', 'login-cookie-and-live-revocation', 'content-whitelist', 'recreate-persistence', 'database-and-log-privacy'], dateRangeBoundaries, totals: before };
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await stop();
  if (volumeCreated) docker('volume', 'rm', volume); // Only this isolated synthetic test volume.
  rmSync(dir, { recursive: true, force: true });
}
