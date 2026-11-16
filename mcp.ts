import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, readJson, sendJson, restOperation } from './graphql.ts';

const versions = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const serverInfo = { name: 'github-core-clone-01-v2', version: '1.0.0' };
const definitions: [string, string, string[], string[]][] = [
  ['create_repo', 'Create a repository for the authenticated owner.', ['name'], ['name', 'description', 'private']],
  ['get_repo', 'Read a repository.', ['owner', 'repo'], ['owner', 'repo']],
  ['create_issue', 'Create an issue in a repository.', ['owner', 'repo', 'title'], ['owner', 'repo', 'title', 'body']],
  ['list_issues', 'List repository issues by state.', ['owner', 'repo'], ['owner', 'repo', 'state']],
  ['create_pull_request', 'Create a pull request between branches.', ['owner', 'repo', 'title', 'head', 'base'], ['owner', 'repo', 'title', 'body', 'head', 'base']],
  ['merge_pull_request', 'Squash merge a pull request.', ['owner', 'repo', 'pull_number'], ['owner', 'repo', 'pull_number']],
];
const tools = Object.freeze(definitions.map(([name, description, required, properties]) => Object.freeze({ name, description, inputSchema: { type: 'object', properties: Object.fromEntries(properties.map(p => [p, { type: p === 'private' ? 'boolean' : p === 'pull_number' ? 'integer' : 'string' }])), required }, annotations: { readOnlyHint: name === 'get_repo' || name === 'list_issues', destructiveHint: name.startsWith('create_') || name.startsWith('merge_') } })));
const toolsJson = JSON.stringify({ tools });
const error = (id: any, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
async function call(name: string, a: any) {
  const full = a.full_name ?? a.repo_full_name ?? a.repository;
  const [fullOwner, fullRepo] = typeof full === 'string' && full.includes('/') ? full.split('/', 2) : [];
  const owner = a.owner ?? a.owner_login ?? fullOwner, repo = a.repo ?? a.repo_name ?? fullRepo ?? a.repository;
  const title = a.title ?? a.issue_title ?? a.pr_title ?? a.pull_request_title ?? a.subject;
  const need = (value: any, label: string) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`); return value; };
  if (name === 'create_repo') return restOperation('POST', '/user/repos', { ...a, name: need(a.name ?? a.repo ?? a.repository, 'name') });
  const path = `/repos/${encodeURIComponent(need(owner, 'owner'))}/${encodeURIComponent(need(repo, 'repo'))}`;
  if (name === 'get_repo') return restOperation('GET', path);
  if (name === 'list_issues') return restOperation('GET', `${path}/issues?state=${encodeURIComponent(a.state ?? 'open')}&per_page=100`);
  if (name === 'create_issue') return restOperation('POST', `${path}/issues`, { title: need(title, 'title'), body: a.body ?? '' });
  if (name === 'create_pull_request') return restOperation('POST', `${path}/pulls`, { title: need(title, 'title'), body: a.body ?? '', head: need(a.head ?? a.head_ref, 'head').replace(/^refs\/heads\//, ''), base: need(a.base ?? a.base_ref, 'base').replace(/^refs\/heads\//, '') });
  const number = Number(a.pull_number ?? a.pull_request_number ?? a.pr_number ?? a.number); if (!Number.isInteger(number) || number < 1) throw new Error('pull_number is required');
  return restOperation('PUT', `${path}/pulls/${number}/merge`, { merge_method: 'squash' });
}
async function dispatch(message: any, req: IncomingMessage): Promise<any> {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(message?.id, -32600, 'Invalid Request');
  if (!('id' in message)) return null;
  const { id, method, params = {} } = message;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return error(id, -32602, 'params must be an object');
  if (req.headers['mcp-method'] && req.headers['mcp-method'] !== method) return error(id, -32020, 'Mcp-Method mismatch');
  if (method === 'tools/call' && req.headers['mcp-name'] && req.headers['mcp-name'] !== params.name) return error(id, -32020, 'Mcp-Name mismatch');
  let result: any;
  if (method === 'server/discover') result = { supportedVersions: versions, serverInfo, capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo } };
  else if (method === 'initialize') result = { protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0], serverInfo, capabilities: { tools: {} } };
  else if (method === 'ping') result = {};
  else if (method === 'tools/list') result = JSON.parse(toolsJson);
  else if (method === 'tools/call') {
    if (!tools.some(t => t.name === params.name)) return error(id, -32602, 'Unknown tool');
    try { result = { content: [{ type: 'text', text: JSON.stringify(await call(params.name, params.arguments ?? {})) }], isError: false }; }
    catch (e) { result = { content: [{ type: 'text', text: (e as Error).message }], isError: true }; }
  } else return error(id, -32601, 'Method not found');
  return { jsonrpc: '2.0', id, result };
}
export async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('MCP-Protocol-Version', versions[0]);
  if (req.headers['mcp-session-id']) res.setHeader('Mcp-Session-Id', req.headers['mcp-session-id']);
  if (!authorized(req)) { sendJson(res, 401, error(null, -32001, 'Bad credentials')); return; }
  if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
  let body: any; try { body = await readJson(req); } catch { sendJson(res, 400, error(null, -32700, 'Parse error')); return; }
  if (Array.isArray(body) && !body.length) { sendJson(res, 200, error(null, -32600, 'Empty batch')); return; }
  const results = await Promise.all((Array.isArray(body) ? body : [body]).map(m => dispatch(m, req)));
  const answers = results.filter(r => r !== null);
  if (!answers.length) { res.writeHead(202); res.end(); return; }
  sendJson(res, 200, Array.isArray(body) ? answers : answers[0]);
}
