// Read inside the actual running test container via stdin. Not a service command.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';

assert.equal(process.versions.node, '24.21.0');
assert.equal(process.versions.openssl, '3.5.8');
assert.equal(process.versions.undici, '7.29.1');
const absent = ['/usr/local/lib/node_modules/npm', '/opt/yarn-v1.22.22',
  '/usr/local/bin/npm', '/usr/local/bin/npx', '/usr/local/bin/yarn', '/usr/local/bin/yarnpkg'];
for (const file of absent) assert.throws(() => lstatSync(file), { code: 'ENOENT' }, file);
assert.deepEqual(readdirSync('/usr/local/lib/node_modules'), []);
assert.deepEqual(readdirSync('/opt').filter(name => name.startsWith('yarn-')), []);
const pcre2Version = execFileSync('dpkg-query', ['-W', '-f=${Version}', 'libpcre2-8-0'], { encoding: 'utf8' });
assert.equal(pcre2Version, '10.42-1+deb12u1');
assert.equal(execFileSync('dpkg', ['-V', 'libpcre2-8-0'], { encoding: 'utf8' }).trim(), '');
const pcre2Files = execFileSync('dpkg-query', ['-L', 'libpcre2-8-0'], { encoding: 'utf8' })
  .split('\n').filter(file => /\/libpcre2-8\.so\.\d+\.\d+\.\d+$/.test(file)).map(file => {
    const content = readFileSync(file);
    return { path: realpathSync(file), bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
  });
assert.equal(pcre2Files.length, 1);
const status = readFileSync('/proc/self/status', 'utf8');
const security = Object.fromEntries(['Uid', 'Gid', 'CapEff', 'NoNewPrivs'].map(name => [name, status.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]]));
assert.equal(process.getuid(), 1000);
assert.equal(process.getgid(), 1000);
assert.equal(security.CapEff, '0000000000000000');
assert.equal(security.NoNewPrivs, '1');
assert.throws(() => writeFileSync('/app/runtime-write-canary', 'synthetic'), { code: 'EROFS' });
console.log(JSON.stringify({ versions: process.versions, platform: process.platform, architecture: process.arch,
  absent, globalNodeModules: [], pcre2: { version: pcre2Version, dpkgVerification: 'clean', files: pcre2Files },
  security, readOnlyRootWriteRejected: true }, null, 2));
