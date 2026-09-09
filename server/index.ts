import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Accounts, connectionKeys, encryptionKey } from './accounts.ts';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { Store } from './store.ts';
import { Providers, credentials } from './providers.ts';
import { Coordinator } from './coordinator.ts';
import { validateTargets } from './domain.ts';

process.umask(0o077);

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage) {
  let data = '';
  for await (const part of req) {
    data += part;
    if (data.length > 16000) throw new Error('Request body too large.');
  }
  return JSON.parse(data || '{}');
}
export function createApp(path = 'data/promiseguard.sqlite', key?: Buffer, port = 4317) {
  const root = new Store(path);
  const accounts = new Accounts(root.db, key || encryptionKey('data/credentials.key', root.db));
  const contexts = new Map<string, {store:Store;providers:Providers;coordinator:Coordinator}>();
  function context(owner: string) {
    let value = contexts.get(owner);
    if (!value) {
      const store = new Store(path, owner);
      const providers = new Providers(() => ({GITHUB_TOKEN:'', NOTION_TOKEN:'', SLACK_BOT_TOKEN:'', ...accounts.credentials(owner), GEMINI_API_KEY:credentials().GEMINI_API_KEY}));
      value = {store, providers, coordinator:new Coordinator(store, providers)};
      contexts.set(owner, value);
    }
    return value;
  }
  for (const row of root.db.prepare('SELECT DISTINCT owner FROM runs').all() as {owner:string}[]) context(row.owner).store.recover();
  const server = createServer(async (req, res) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const activePort = port || (server.address() as {port:number}).port;
    const allowedHosts = [`127.0.0.1:${activePort}`, `localhost:${activePort}`];
    if (!allowedHosts.includes(req.headers.host || '')) return json(res, 403, { error: 'Local access only.' });
    if (req.headers.origin && !allowedHosts.some(host => req.headers.origin === `http://${host}`)) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site requests are not allowed.' });
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      if (url.pathname.startsWith('/api/')) {
        const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('pg_session='))?.slice(11) || '';
        if (req.method !== 'GET' && (!allowedHosts.some(host => req.headers.origin === `http://${host}`) || !req.headers['content-type']?.startsWith('application/json'))) return json(res, 403, {error:'Same-origin JSON request required.'});
        if (req.method === 'POST' && url.pathname === '/api/login') {
          const input = await body(req);
          if (typeof input.name !== 'string' || input.name.length > 100 || typeof input.password !== 'string' || input.password.length > 256) return json(res, 400, {error:'Invalid sign-in input.'});
          try {
            const result = await accounts.login(input.name, input.password);
            accounts.logout(token);
            res.setHeader('Set-Cookie', `pg_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
            return json(res, 200, {user:result.user});
          } catch (error) { return json(res, 401, {error:(error as Error).message}); }
        }
        const user = accounts.session(token);
        if (!user) return json(res, 401, {error:'Sign in to your workspace.'});
        if (req.method !== 'GET' && req.headers['x-promiseguard-session'] !== user.csrf) return json(res, 403, {error:'Refresh the page before making changes.'});
        if (req.method === 'POST' && url.pathname === '/api/logout') {
          accounts.logout(token);
          res.setHeader('Set-Cookie', 'pg_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
          return json(res, 200, {ok:true});
        }
        const {store,providers,coordinator} = context(user.id);
        const session = user.csrf;
        if (req.method === 'POST' && url.pathname === '/api/connections/save') {
          if (coordinator.busy || store.list().some(r => ['review','partial'].includes(r.status))) throw new Error('Finish or dismiss the current run before changing connections.');
          const input = await body(req);
          if (!(connectionKeys as readonly string[]).includes(input.provider) || typeof input.token !== 'string' || input.token.length > 8000) throw new Error('Invalid connection.');
          accounts.setConnection(user.id, input.provider, input.token.trim());
          return json(res, 200, {ok:true});
        }
        if (req.method === 'GET' && url.pathname === '/api/bootstrap') return json(res, 200, { session, user: {id:user.id,name:user.name}, configured: Object.fromEntries(Object.entries(providers.getCredentials()).map(([key, value]) => [key, Boolean(value)])), targets: store.setting('targets'), runs: store.list() });
        if (req.method === 'GET' && url.pathname === '/api/runs') {
          if (req.headers['x-promiseguard-session'] !== session) return json(res, 403, {error:'Refresh after switching accounts.'});
          return json(res, 200, store.list());
        }
        if (req.method === 'POST' && url.pathname === '/api/connections') return json(res, 200, await providers.connections());
        if (req.method === 'POST' && url.pathname === '/api/slack/check') {
          const input = await body(req);
          if (typeof input.channel !== 'string' || typeof input.thread !== 'string') throw new Error('Provide the Slack channel and discussion link.');
          return json(res, 200, await providers.checkSlackThread(input.channel, input.thread));
        }
        if (req.method === 'POST' && url.pathname === '/api/analyze') {
          const targets = validateTargets(await body(req));
          if (targets.slackChannel) {
            const thread = await providers.checkSlackThread(targets.slackChannel, targets.slackThread);
            targets.slackChannel = thread.channelId;
            targets.slackThread = thread.url;
          }
          const run = coordinator.start(targets);
          store.setSetting('targets', targets);
          return json(res, 202, run);
        }
        const match = url.pathname.match(/^\/api\/runs\/([a-f\d-]+)\/(approve|dismiss)$/);
        if (req.method === 'POST' && match) {
          const input = await body(req);
          return json(res, 200, match[2] === 'approve' ? coordinator.approve(match[1], input.planHash) : coordinator.dismiss(match[1]));
        }
        return json(res, 404, { error: 'Endpoint not found.' });
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
      const path = resolve('dist', `.${url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)}`);
      if (!path.startsWith(resolve('dist') + '/')) return json(res, 404, { error: 'File not found.' });
      if (!existsSync(path)) return json(res, 404, { error: 'Build the frontend with npm run build first.' });
      const mime: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(readFileSync(path));
    } catch (error) {
      const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('pg_session='))?.slice(11) || '';
      const user = accounts.session(token);
      json(res, 400, { error: user ? context(user.id).providers.redact((error as Error).message) : 'Request failed.' });
    }
  });
  server.on('close', () => { for (const c of contexts.values()) c.store.db.close(); root.db.close(); });
  return {server, accounts};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {server} = createApp();
  server.listen(4317, '127.0.0.1', () => console.log('PromiseGuard running at http://127.0.0.1:4317'));
  server.on('error', error => { console.error(`Server could not start: ${error.message}`); process.exitCode = 1; });
}
