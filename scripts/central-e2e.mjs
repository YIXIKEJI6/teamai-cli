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
const id = `teamai-e2e-${randomUUID()}`, volume = `${id}-data`, restoreVolume = `${id}-restore`, logFile = path.join(dir, 'server.log');
const env = { ...process.env, TEAMAI_CENTRAL_AUTH_FILE: path.join(configDir, 'auth.json'), TEAMAI_CENTRAL_DB: db, TEAMAI_CENTRAL_ORIGIN: origin, TEAMAI_CENTRAL_PORT: String(port), TEAMAI_CENTRAL_HOST: '127.0.0.1' };
const limits = ['--read-only', '--user', '1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=256m', '--cpus=1', '--tmpfs', '/tmp:size=16m,noexec,nosuid'];
let activeVolume = volume, activeDb = db;
const dockerArgs = () => [...limits, '--mount', `source=${activeVolume},target=/data`, '--mount', `type=bind,source=${configDir},target=/run/teamai,readonly`, '-e', 'TEAMAI_CENTRAL_AUTH_FILE=/run/teamai/auth.json', '-e', `TEAMAI_CENTRAL_ORIGIN=${origin}`];
let processHandle, started = false;
const ownedVolumes = [], constraints = [], migrations = [];
let runtime = null, health = null;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function migrate() {
  if (mode === 'docker') docker('run', '--rm', ...dockerArgs(), image, 'migrate');
  else execFileSync(process.execPath, ['dist/central.js', 'migrate'], { env: { ...env, TEAMAI_CENTRAL_DB: activeDb }, stdio: 'pipe' });
  migrations.push({ volume: activeVolume === volume ? 'original' : 'restored', completed: true });
}
function inService(program, args = []) {
  return mode === 'docker'
    ? docker('exec', id, 'node', '--input-type=module', '-e', program, ...args)
    : execFileSync(process.execPath, ['--input-type=module', '-e', program, ...args], { env: { ...env, TEAMAI_CENTRAL_DB: activeDb }, encoding: 'utf8', timeout: 30_000 });
}
const databaseProbe = `
  import assert from 'node:assert/strict';
  import { DatabaseSync, backup } from 'node:sqlite';
  import { existsSync, readFileSync } from 'node:fs';
  const file = process.env.TEAMAI_CENTRAL_DB;
  assert(existsSync(file));
  const database = new DatabaseSync(file);
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(database.prepare('SELECT dataset FROM dataset_metadata WHERE id = 1').get().dataset, 'synthetic');
`;
function checkConstraints() {
  const container = JSON.parse(docker('inspect', id))[0], host = container.HostConfig;
  assert.equal(container.Config.User, '1000:1000');
  assert.equal(host.ReadonlyRootfs, true); assert(host.CapDrop.includes('ALL'));
  assert(host.SecurityOpt.some(option => option.startsWith('no-new-privileges')));
  assert.equal(host.Memory, 256 * 1024 * 1024); assert.equal(host.NanoCpus, 1_000_000_000);
  for (const option of ['size=16m', 'noexec', 'nosuid']) assert(host.Tmpfs['/tmp'].includes(option));
  assert.equal(host.PortBindings['3722/tcp'][0].HostIp, '127.0.0.1');
  assert(container.Mounts.some(mount => mount.Destination === '/data' && mount.Name === activeVolume && mount.RW));
  assert(container.Mounts.some(mount => mount.Destination === '/run/teamai' && !mount.RW));
  constraints.push({ volume: activeVolume === volume ? 'original' : 'restored', user: container.Config.User,
    readOnlyRootfs: host.ReadonlyRootfs, capDrop: host.CapDrop, securityOpt: host.SecurityOpt,
    memory: host.Memory, nanoCpus: host.NanoCpus, tmpfs: host.Tmpfs,
    loopbackOnly: true, authMountReadOnly: true, independentDataVolume: true });
}
async function start() {
  if (mode === 'docker') { docker('run', '-d', '--name', id, ...dockerArgs(), '-p', `127.0.0.1:${port}:3722`, image, 'serve'); started = true; checkConstraints(); }
  else { const fd = openSync(logFile, 'a', 0o600); processHandle = spawn(process.execPath, ['dist/central.js', 'serve'], { env: { ...env, TEAMAI_CENTRAL_DB: activeDb }, stdio: ['ignore', fd, fd] }); closeSync(fd); started = true; }
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
    docker('volume', 'create', volume); ownedVolumes.push(volume);
    assert.equal(docker('image', 'inspect', image, '--format', '{{.Config.User}}').trim(), '1000:1000');
    assert.equal(docker('run', '--rm', ...dockerArgs(), '--entrypoint', 'node', image, '-e', "process.stdout.write(String(require('node:fs').existsSync('/data/usage.sqlite')))").trim(), 'false');
  }
  migrate(); migrate();
  await start();
  if (mode === 'docker') {
    runtime = JSON.parse(execFileSync('docker', ['exec', '-i', id, 'node', '--input-type=module'], {
      input: readFileSync(new URL('./central-runtime-check.mjs', import.meta.url)), encoding: 'utf8', timeout: 30_000,
    }));
    for (let i = 0; i < 45; i++) {
      health = JSON.parse(docker('inspect', id, '--format', '{{json .State.Health}}'));
      if (health.Status === 'healthy') break;
      await wait(1000);
    }
    assert.equal(health.Status, 'healthy', 'Image HEALTHCHECK must really execute');
    assert(health.Log.some(entry => entry.ExitCode === 0));
  }
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
  // Fixture-only update in the driver's owned synthetic database, never a public delete API.
  const softDelete = JSON.parse(inService(databaseProbe + `
    try {
      database.exec('BEGIN IMMEDIATE');
      const update = database.prepare('UPDATE usage_snapshots SET del_status = 1 WHERE session_id = ? AND del_status = 0');
      const first = update.run(process.argv[1]).changes, repeated = update.run(process.argv[1]).changes;
      const row = database.prepare('SELECT session_id, del_status FROM usage_snapshots WHERE session_id = ?').get(process.argv[1]);
      const physicalRows = database.prepare('SELECT count(*) AS total FROM usage_snapshots').get().total;
      assert.equal(first, 1); assert.equal(repeated, 0); assert.equal(row.del_status, 1); assert.equal(physicalRows, 2);
      database.exec('COMMIT');
      console.log(JSON.stringify({ first, repeated, row, physicalRows, schema: 1, dataset: 'synthetic' }));
    } finally { database.close(); }
  `, [sb.sessionId]));
  const afterDeletion = await get(); assert.equal(afterDeletion.sessions, 1); assert.equal(afterDeletion.tokens.input, 150);
  assert.equal((await get('&member=synthetic-b&project=project-beta')).sessions, 0);
  const backupResult = JSON.parse(inService(databaseProbe + `
    try {
      const destination = file + '.backup'; assert(!existsSync(destination));
      const pages = await backup(database, destination);
      console.log(JSON.stringify({ pages, bytes: readFileSync(destination).toString('base64') }));
    } finally { database.close(); }
  `));
  const backupBytes = Buffer.from(backupResult.bytes, 'base64'); assert(backupResult.pages > 0);
  await stop();
  activeVolume = restoreVolume; activeDb = path.join(dir, 'restored.sqlite');
  if (mode === 'docker') {
    docker('volume', 'create', restoreVolume); ownedVolumes.push(restoreVolume);
    execFileSync('docker', ['run', '--rm', '-i', ...limits, '--mount', `source=${restoreVolume},target=/data`, '--entrypoint', 'node', image,
      '-e', "const fs=require('node:fs');fs.writeFileSync('/data/usage.sqlite',fs.readFileSync(0),{flag:'wx',mode:0o600});"], { input: backupBytes, timeout: 30_000 });
  } else writeFileSync(activeDb, backupBytes, { flag: 'wx', mode: 0o600 });
  migrate(); migrate();
  await start();
  assert.equal((await fetch(origin + '/api/usage/summary')).status, 401);
  assert.deepEqual(await get(), afterDeletion);
  assert.equal((await (await send(newer, a)).json()).result, 'duplicate');
  const restored = JSON.parse(inService(databaseProbe + `
    try {
      const physicalRows = database.prepare('SELECT count(*) AS total FROM usage_snapshots').get().total;
      const row = database.prepare('SELECT session_id, del_status FROM usage_snapshots WHERE session_id = ?').get(process.argv[1]);
      console.log(JSON.stringify({ physicalRows, row, schema: 1, dataset: 'synthetic' }));
    } finally { database.close(); }
  `, [sb.sessionId]));
  assert.deepEqual(restored.row, softDelete.row); assert.equal(restored.physicalRows, 2);
  await stop();
  let stored;
  if (mode === 'docker') stored = docker('run', '--rm', ...limits, '--mount', `source=${restoreVolume},target=/data,readonly`, '--entrypoint', 'node', image, '-e', "const fs=require('node:fs');process.stdout.write(fs.readFileSync('/data/usage.sqlite').toString('base64'));");
  else stored = readFileSync(activeDb).toString('base64');
  const storage = Buffer.from(stored, 'base64').toString('utf8'), logs = readFileSync(logFile, 'utf8');
  for (const forbidden of [admin, a, b, 'PRIVATE_CONTENT_CANARY', 'promptSummary', 'tokenHash']) { assert(!storage.includes(forbidden)); assert(!logs.includes(forbidden)); }
  const evidence = { mode, dataset: 'synthetic', checkedAt: new Date().toISOString(), image: mode === 'docker' ? image : null, uid: mode === 'docker' ? 1000 : process.getuid?.(), checks: ['two-members-two-projects', 'unknown-buckets', 'filters-and-empty', 'inclusive-date-range-boundary', 'replay-and-ordering', 'invalid-forged-revoked-expired-auth', 'login-cookie-and-live-revocation', 'content-whitelist', 'recreate-persistence', 'soft-delete-physical-row-and-hidden-summary', 'consistent-backup-independent-restore', 'repeated-migration', 'database-and-log-privacy'], dateRangeBoundaries, totals: before,
    runtime, health, constraints, migrations, softDelete, afterDeletion,
    backup: { method: 'node:sqlite backup API while service running', pages: backupResult.pages, bytes: backupBytes.length, sha256: hash(backupBytes), independentRestore: true, restored } };
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await stop();
  for (const ownedVolume of ownedVolumes) docker('volume', 'rm', ownedVolume); // Only this driver's isolated synthetic volumes.
  rmSync(dir, { recursive: true, force: true });
}
