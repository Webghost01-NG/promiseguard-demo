import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { Store } from './store.ts';
import { Providers, credentials, redact } from './providers.ts';
import { Coordinator } from './coordinator.ts';
import { validateTargets } from './domain.ts';

process.umask(0o077);
const port = 4317;
const store = new Store();
const providers = new Providers();
const coordinator = new Coordinator(store, providers);
const session = randomBytes(32).toString('hex');
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
const server = createServer(async (req, res) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowedHosts.includes(req.headers.host || '')) return json(res, 403, { error: 'Local access only.' });
  if (req.headers.origin && !allowedHosts.some(host => req.headers.origin === `http://${host}`)) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
  if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site requests are not allowed.' });
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && (req.headers['x-promiseguard-session'] !== session || !req.headers['content-type']?.startsWith('application/json'))) return json(res, 403, { error: 'Refresh the page before making changes.' });
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') return json(res, 200, { session, configured: Object.fromEntries(Object.entries(credentials()).map(([key, value]) => [key, Boolean(value)])), targets: store.setting('targets'), runs: store.list() });
      if (req.method === 'GET' && url.pathname === '/api/runs') return json(res, 200, store.list());
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
    json(res, 400, { error: redact((error as Error).message) });
  }
});
server.listen(port, '127.0.0.1', () => {
  store.recover();
  console.log(`PromiseGuard running at http://127.0.0.1:${port}`);
});
server.on('error', error => { console.error(`Server could not start: ${error.message}`); process.exitCode = 1; store.db.close(); });
