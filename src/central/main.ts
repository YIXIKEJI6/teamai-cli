import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './store.js';
import { createCentralServer } from './server.js';
import { readAuth } from './contract.js';

process.umask(0o077);
try {
  const action = process.argv[2], db = process.env.TEAMAI_CENTRAL_DB;
  if (!db) throw new Error('TEAMAI_CENTRAL_DB is required');
  if (action === 'migrate') {
    if (!process.env.TEAMAI_CENTRAL_AUTH_FILE) throw new Error('Auth file is required');
    migrate(db, path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations/001-initial.sql'), readAuth(process.env.TEAMAI_CENTRAL_AUTH_FILE).dataset);
    console.log('Central schema version 1 is ready.');
  } else if (action === 'serve') {
    const auth = process.env.TEAMAI_CENTRAL_AUTH_FILE, origin = process.env.TEAMAI_CENTRAL_ORIGIN;
    if (!auth || !origin) throw new Error('Auth file and public origin are required');
    const port = Number(process.env.TEAMAI_CENTRAL_PORT ?? '3722');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
    const server = createCentralServer({ db, auth, origin });
    server.listen(port, process.env.TEAMAI_CENTRAL_HOST ?? '127.0.0.1', () => console.log('Central usage service is listening.'));
    server.on('error', () => { console.error('Central service could not listen.'); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeIdleConnections(); });
  } else throw new Error('Usage: node dist/central.js migrate|serve');
} catch {
  console.error('Central service failed. Check the explicit migration, paths, runtime and credential configuration.');
  process.exitCode = 1;
}
