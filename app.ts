import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import { handleGit } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

let appRequestId = 0;
const json = (res: ServerResponse, status: number, body: unknown) => { const buf = Buffer.from(JSON.stringify(body)); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'x-github-request-id': `v2-${++appRequestId}` }); res.end(buf); };
export function createApp(): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const raw = req.url ?? '/'; const q = raw.indexOf('?'); const path = q < 0 ? raw : raw.slice(0, q); const method = req.method ?? 'GET';
    if (path === '/healthz' && method === 'GET') { json(res, 200, { ok: true }); return; }
    const url = new URL(raw, 'http://entry');
    if (path === '/api/v3' || path.startsWith('/api/v3/')) { await handleRest(req, res, url); return; }
    if (path === '/api/graphql' && method === 'POST') { await handleGraphQL(req, res); return; }
    if (path === '/mcp' && (method === 'POST' || method === 'DELETE')) { await handleMcp(req, res); return; }
    const first = path.indexOf('/', 1); const second = first < 0 ? -1 : path.indexOf('/', first + 1); const end = second < 0 ? path.length : second;
    if (second >= 0 && path.slice(first + 1, end).endsWith('.git')) { await handleGit(req, res, url, decodeURIComponent(path.slice(1, first)), decodeURIComponent(path.slice(first + 1, end - 4))); return; }
    json(res, 404, { message: 'Not Found' });
  });
  server.keepAliveTimeout = 5000;
  return server;
}
