import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { active, bindSnapshot, digest, matches, readAuth, type AuthConfig } from './contract.js';
import { Conflict, Store } from './store.js';
import { dashboardHtml, loginHtml } from './html.js';

class HttpError extends Error { constructor(public status: number) { super('Request rejected'); } }
async function body(req: http.IncomingMessage, max = 8192): Promise<string> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > max) { req.resume(); throw new HttpError(413); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function date(value: string | null, fallback: string): string {
  if (value === null) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new HttpError(400);
  return value;
}
export function createCentralServer(options: { db: string; auth: string; origin: string }) {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || origin.username || origin.password ||
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) {
    throw new Error('Public origin must be HTTPS (HTTP only for loopback validation)');
  }
  const initial = readAuth(options.auth), dataset = initial.dataset;
  const store = new Store(options.db, dataset);
  const sessions = new Map<string, { admin: string; tokenHash: string; expires: number }>();
  const attempts = new Map<string, { count: number; until: number }>();
  function admin(req: http.IncomingMessage, config: AuthConfig): boolean {
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (config.admins.some(c => active(c) && matches(token, c.tokenHash))) return true;
    const cookie = req.headers.cookie?.match(/(?:^|;\s*)teamai_session=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
    const session = cookie ? sessions.get(digest(cookie)) : undefined;
    return !!session && session.expires > Date.now() && config.admins.some(c => c.id === session.admin && c.tokenHash === session.tokenHash && active(c));
  }
  const server = http.createServer(async (req, res) => {
    const nonce = randomBytes(18).toString('base64');
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    const html = (status: number, value: string) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(value); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Native same-origin form POSTs need a non-opaque Origin for strict CSRF checks.
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    let route = 'unknown';
    try {
      const url = new URL(req.url ?? '/', origin);
      route = ['/', '/login', '/logout', '/healthz', '/api/usage/options', '/api/usage/report', '/api/usage/summary'].includes(url.pathname) ? url.pathname : 'unknown';
      if (url.origin !== origin.origin || url.search.length > 1024) throw new HttpError(400);
      if (req.headers.origin && req.headers.origin !== origin.origin) throw new HttpError(403);
      if (req.method === 'GET' && route === '/healthz') { json(store.health() ? 200 : 503, { status: 'ok' }); return; }
      const config = readAuth(options.auth); // Revocation and expiry apply on every request, including existing sessions.
      if (config.dataset !== dataset) throw new Error('Dataset cannot change while serving');
      if (req.method === 'GET' && route === '/login') { html(200, loginHtml(nonce)); return; }
      if (req.method === 'POST' && (route === '/login' || route === '/logout')) {
        if (req.headers.origin !== origin.origin) throw new HttpError(403);
        if (route === '/logout') {
          const cookie = req.headers.cookie?.match(/teamai_session=([A-Za-z0-9_-]{43})/)?.[1];
          if (cookie) sessions.delete(digest(cookie));
          res.setHeader('Set-Cookie', `teamai_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${origin.protocol === 'https:' ? '; Secure' : ''}`);
        } else {
          const address = req.socket.remoteAddress ?? 'unknown', now = Date.now();
          for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
          const attempt = attempts.get(address) ?? { count: 0, until: now + 60_000 };
          if (++attempt.count > 20 || attempts.size > 1000) throw new HttpError(429);
          attempts.set(address, attempt);
          if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new HttpError(415);
          const form = new URLSearchParams(await body(req, 1024));
          if ([...form.keys()].length !== 2 || !form.has('id') || !form.has('token')) throw new HttpError(400);
          const credential = config.admins.find(c => c.id === form.get('id') && active(c) && matches(form.get('token') ?? '', c.tokenHash));
          if (!credential) { html(401, loginHtml(nonce, true)); return; }
          for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key);
          if (sessions.size >= 100) throw new HttpError(429);
          const token = randomBytes(32).toString('base64url');
          sessions.set(digest(token), { admin: credential.id, tokenHash: credential.tokenHash, expires: now + 8 * 3600_000 });
          res.setHeader('Set-Cookie', `teamai_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${origin.protocol === 'https:' ? '; Secure' : ''}`);
        }
        res.writeHead(303, { Location: route === '/logout' ? '/login' : '/' }); res.end(); return;
      }
      if (req.method === 'POST' && route === '/api/usage/report') {
        const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? '';
        const installation = config.installations.find(c => active(c) && matches(token, c.tokenHash));
        if (!installation) throw new HttpError(401);
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new HttpError(415);
        let value;
        try { value = bindSnapshot(JSON.parse(await body(req)), installation); }
        catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400); }
        json(200, { ok: true, result: store.accept(value) }); return;
      }
      if (req.method === 'GET' && ['/', '/api/usage/summary', '/api/usage/options'].includes(route)) {
        if (!admin(req, config)) {
          if (route === '/') { res.setHeader('Location', '/login'); html(401, loginHtml(nonce)); return; }
          throw new HttpError(401);
        }
        if (route === '/') { html(200, dashboardHtml(nonce)); return; }
        if (route === '/api/usage/options') {
          json(200, { members: [...new Set(config.installations.map(i => i.memberId))].sort(), projects: [...new Set(config.installations.flatMap(i => i.projects))].sort() }); return;
        }
        for (const key of url.searchParams.keys()) if (!['member', 'project', 'from', 'to'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400);
        const today = new Date().toISOString().slice(0, 10), from = date(url.searchParams.get('from'), today), to = date(url.searchParams.get('to'), today);
        const inclusiveDays = (Date.parse(to) - Date.parse(from)) / 86400_000 + 1;
        if (inclusiveDays < 1 || inclusiveDays > 366) throw new HttpError(400);
        const filter = z.object({ member: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(), project: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(), from: z.string(), to: z.string() })
          .safeParse({ member: url.searchParams.get('member') ?? undefined, project: url.searchParams.get('project') ?? undefined, from, to });
        if (!filter.success) throw new HttpError(400);
        json(200, { dataset, ...store.summary(filter.data) }); return;
      }
      throw new HttpError(route === 'unknown' ? 404 : 405);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof Conflict ? 409 : 503;
      if (!res.headersSent) json(status, { error: ({ 400: '上报字段、身份或筛选条件无效', 401: '需要有效身份凭据', 403: '请求来源不被允许', 409: '快照标识或累计计数冲突', 413: '请求内容过大', 415: '请求格式不受支持', 429: '请求过于频繁' } as Record<number, string>)[status] ?? '请求未完成，请检查服务状态' });
    } finally {
      // Only fixed route names and status are logged. Never request bodies, query strings, credentials or errors containing input.
      process.stdout.write(JSON.stringify({ event: 'http', route, status: res.statusCode }) + '\n');
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxHeadersCount = 30;
  server.on('close', () => store.close());
  return server;
}
