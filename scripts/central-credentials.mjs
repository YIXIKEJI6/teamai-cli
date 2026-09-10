// Explicit operator step. No user configuration, Hook or transcript access.
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [identityFile, output] = process.argv.slice(2);
assert(identityFile && output, 'Usage: node scripts/central-credentials.mjs reviewed-identities.json NEW-output-directory');
const identities = JSON.parse(readFileSync(identityFile, 'utf8'));
assert(['synthetic', 'production'].includes(identities.dataset));
assert(Array.isArray(identities.admins) && identities.admins.length > 0);
assert(Array.isArray(identities.installations));
const alias = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v);
assert(identities.admins.every(alias));
for (const item of identities.installations) assert(alias(item.memberId) && alias(item.installationId) && Array.isArray(item.projects) && item.projects.length > 0 && item.projects.every(alias));
assert(new Set(identities.admins).size === identities.admins.length);
assert(new Set(identities.installations.map(i => i.installationId)).size === identities.installations.length);
assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(identities.expiresAt) && Date.parse(identities.expiresAt) > Date.now());
process.umask(0o077); mkdirSync(output); mkdirSync(path.join(output, 'server')); mkdirSync(path.join(output, 'client-secrets'));
function issue(key) {
  const value = randomBytes(32).toString('base64url');
  writeFileSync(path.join(output, 'client-secrets', key + '.token'), value + '\n', { flag: 'wx', mode: 0o600 });
  return { tokenHash: createHash('sha256').update(value).digest('hex'), expiresAt: identities.expiresAt, revoked: false };
}
const config = { schemaVersion: 1, dataset: identities.dataset,
  admins: identities.admins.map(id => ({ id, ...issue('admin-' + id) })),
  installations: identities.installations.map(({ memberId, installationId, projects }) => ({ memberId, installationId, projects, ...issue('install-' + installationId) })),
};
writeFileSync(path.join(output, 'server', 'auth.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('Generated server/auth.json (hashes only) and separate client-secrets/*.token. No credentials printed.');
