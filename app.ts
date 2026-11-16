import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { nextRequestId } from './store.ts';

export interface RequestQuery {
  raw: string;
  params: Map<string, string>;
}

type StaticHandler = (req: IncomingMessage, res: ServerResponse, query: RequestQuery) => Promise<void>;

const emptyQuery: RequestQuery = { raw: '', params: new Map() };

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function decodeQueryPart(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return '';
  }
}

function parseQuery(raw: string): RequestQuery {
  if (raw === '') return emptyQuery;
  const params = new Map<string, string>();
  for (const field of raw.split('&')) {
    if (field === '') continue;
    const equals = field.indexOf('=');
    const key = decodeQueryPart(equals < 0 ? field : field.slice(0, equals));
    const value = equals < 0 ? '' : decodeQueryPart(field.slice(equals + 1));
    if (!params.has(key)) params.set(key, value);
  }
  return { raw, params };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(bytes);
}

async function healthHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    json(res, 404, { message: 'Not Found' });
    return;
  }
  json(res, 200, { ok: true });
}

async function restRootHandler(req: IncomingMessage, res: ServerResponse, query: RequestQuery): Promise<void> {
  await handleRest(req, res, [], query);
}

async function graphqlHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    json(res, 404, { message: 'Not Found' });
    return;
  }
  await handleGraphQL(req, res);
}

async function mcpHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    json(res, 404, { message: 'Not Found' });
    return;
  }
  await handleMcp(req, res);
}

const staticRoutes = new Map<string, StaticHandler>([
  ['/healthz', healthHandler],
  ['/api/v3', restRootHandler],
  ['/api/graphql', graphqlHandler],
  ['/mcp', mcpHandler],
]);

function restSegments(path: string): string[] | null {
  const prefix = '/api/v3/';
  if (!path.startsWith(prefix)) return null;
  const segments: string[] = [];
  let at = prefix.length;
  while (at < path.length) {
    const slash = path.indexOf('/', at);
    const end = slash < 0 ? path.length : slash;
    const raw = path.slice(at, end);
    if (raw !== '') {
      const decoded = decodeSegment(raw);
      if (decoded === null) return null;
      segments.push(decoded);
    }
    if (slash < 0) break;
    at = slash + 1;
  }
  return segments;
}

function gitRoute(path: string, query: RequestQuery): { owner: string; repo: string; operation: string; service: string } | null {
  const ownerEnd = path.indexOf('/', 1);
  if (ownerEnd <= 1) return null;
  const repoEnd = path.indexOf('/', ownerEnd + 1);
  if (repoEnd < 0) return null;
  const ownerRaw = path.slice(1, ownerEnd);
  const repoRaw = path.slice(ownerEnd + 1, repoEnd);
  if (!repoRaw.endsWith('.git')) return null;
  const owner = decodeSegment(ownerRaw);
  const repo = decodeSegment(repoRaw.slice(0, -4));
  if (owner === null || repo === null) return null;
  const operation = path.slice(repoEnd + 1);
  if (operation !== 'info/refs' && operation !== 'git-upload-pack' && operation !== 'git-receive-pack') return null;
  const service = query.params.get('service') ?? '';
  return { owner, repo, operation, service };
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const target = req.url ?? '/';
  const question = target.indexOf('?');
  const path = question < 0 ? target : target.slice(0, question);
  const query = question < 0 ? emptyQuery : parseQuery(target.slice(question + 1));
  const staticHandler = staticRoutes.get(path);
  if (staticHandler !== undefined) {
    await staticHandler(req, res, query);
    return;
  }
  if (path.startsWith('/api/v3/')) {
    const segments = restSegments(path);
    if (segments === null) {
      json(res, 400, { message: 'Bad Request' });
      return;
    }
    await handleRest(req, res, segments, query);
    return;
  }
  const git = gitRoute(path, query);
  if (git !== null) {
    await handleGit(req, res, git.owner, git.repo, git.operation, git.service);
    return;
  }
  json(res, 404, { message: 'Not Found' });
}

export function createApp(): Server {
  const server = createServer((req, res) => {
    void route(req, res).catch(() => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      json(res, 500, { message: 'Internal Server Error' });
    });
  });
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;
  return server;
}
