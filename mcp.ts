import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, getRepo, createRepo, isAncestor, mergeBaseOf, nextRequestId, now, owner, repos, setTree, treeAt, type Issue, type Pull, type Repo } from './store.ts';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buffer = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(buffer.length),
    'X-GitHub-Request-Id': String(nextRequestId()),
  });
  res.end(buffer);
}

export function jsonRpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
}

const stringProp = (description: string) => ({ type: 'string', description });
const booleanProp = (description: string) => ({ type: 'boolean', description });

function repoText(repo: { name: string; full_name: string; description: string; private: boolean; default_branch: string; html_url: string }): string {
  return JSON.stringify(repo);
}

export const TOOLS: ToolSpec[] = [
  {
    name: 'create_repository',
    description: 'Create a repository',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The name of the new repository'),
        description: stringProp('A short description of the repository'),
        private: booleanProp('Whether the repository is private'),
      },
      required: ['name'],
    },
  },
  {
    name: 'list_repositories',
    description: 'List repositories',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repositories'),
      },
      required: [],
    },
  },
  {
    name: 'get_repository',
    description: 'Get a single repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_repo',
    description: 'Create a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        name: stringProp('The name of the new repository'),
        description: stringProp('A short description of the repository'),
        private: booleanProp('Whether the repository is private'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a single repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repositories'),
      },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
        title: stringProp('The issue title'),
        body: stringProp('The issue body'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
        state: stringProp('Filter by state (open, closed)'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
        title: stringProp('The pull request title'),
        body: stringProp('The pull request body'),
        head: stringProp('The name of the head branch'),
        base: stringProp('The name of the base branch'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
        number: { type: 'integer', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'get_file_contents',
    description: 'Get the contents of a file in a repository at a ref',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
        path: stringProp('The file path'),
        ref: stringProp('The branch name or commit sha'),
      },
      required: ['owner', 'repo', 'path'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
        state: stringProp('Filter by state (open, closed)'),
      },
      required: ['owner', 'repo'],
    },
  },
];

function toRepoText(repo: Repo): string {
  return repoText({
    name: repo.name,
    full_name: `${repo.owner.login}/${repo.name}`,
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    html_url: `http://localhost/${repo.owner.login}/${repo.name}`,
  });
}

function callCreateRepository(args: Record<string, unknown>): string {
  const name = pick(args, ['name', 'repository_name']);
  if (name.trim() === '') throw new Error('Missing required argument: name');
  const description = typeof args.description === 'string' ? args.description : '';
  const isPrivate = typeof args.private === 'boolean' ? args.private : false;
  const repo = createRepo(name, { description, private: isPrivate });
  return toRepoText(repo);
}

function callListRepositories(args: Record<string, unknown>): string {
  const requestedOwner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : null;
  const out: { name: string; full_name: string; description: string; private: boolean; default_branch: string }[] = [];
  for (const repo of repos.values()) {
    if (requestedOwner !== null && repo.owner.login !== requestedOwner) continue;
    out.push({
      name: repo.name,
      full_name: `${repo.owner.login}/${repo.name}`,
      description: repo.description,
      private: repo.private,
      default_branch: repo.defaultBranch,
    });
  }
  return JSON.stringify(out);
}

function callGetRepository(args: Record<string, unknown>): string {
  const repoOwner = pick(args, ['owner', 'owner_login']) || owner.login;
  const name = pick(args, ['name', 'repo', 'repository_name', 'repository']);
  if (name === '') throw new Error('Missing required argument: name');
  const repo = getRepo(repoOwner, name);
  if (repo === undefined) throw new Error(`Repository not found: ${repoOwner}/${name}`);
  return toRepoText(repo);
}

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => string> = {
  create_repository: callCreateRepository,
  list_repositories: callListRepositories,
  get_repository: callGetRepository,
  create_repo: callCreateRepository,
  get_repo: callGetRepository,
  list_repos: callListRepositories,
};

export function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    const aliases = REQUIRED_ALIASES[required] ?? [required];
    const present = aliases.some((alias) => args[alias] !== undefined && args[alias] !== null);
    if (!present) throw new Error(`Missing required argument: ${required}`);
  }
  const handler = TOOL_HANDLERS[name];
  if (handler === undefined) throw new Error(`Unknown tool: ${name}`);
  const text = handler(args);
  return { content: [{ type: 'text', text }], isError: false };
}

export function listTools(): Record<string, unknown> {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') throw new Error(`Missing required argument: ${name}`);
  return value;
}

function pick(args: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

function requirePick(args: Record<string, unknown>, names: string[]): string {
  const value = pick(args, names);
  if (value === '') throw new Error(`Missing required argument: ${names[0]}`);
  return value;
}

function pickNumber(args: Record<string, unknown>, names: string[]): number {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  throw new Error(`Missing required argument: ${names[0]}`);
}

const REQUIRED_ALIASES: Record<string, string[]> = {
  owner: ['owner', 'owner_login'],
  name: ['name', 'repo', 'repository_name', 'repository'],
  number: ['number', 'pull_number', 'pr_number', 'pull_request_number', 'issue_number'],
  title: ['title'],
  head: ['head'],
  base: ['base'],
  path: ['path'],
};

function branchTip(repo: { refs: Map<string, string> }, name: string): string | undefined {
  return repo.refs.get(name.startsWith('refs/') ? name : `refs/heads/${name}`);
}

function lookupRepo(args: Record<string, unknown>): { repoOwner: string; repo: Repo } {
  const repoOwner = requirePick(args, ['owner', 'owner_login']);
  const name = requirePick(args, ['name', 'repo', 'repository_name', 'repository']);
  const repo = getRepo(repoOwner, name);
  if (repo === undefined) throw new Error('Not Found');
  return { repoOwner, repo };
}

function callCreateIssue(args: Record<string, unknown>): string {
  const { repo } = lookupRepo(args);
  const title = requireString(args, 'title');
  const body = typeof args.body === 'string' ? args.body : '';
  const created = now();
  const number = repo.nextIssue;
  repo.nextIssue += 1;
  const issue: Issue = { id: number, number, title, body, state: 'open', labels: [], created_at: created, updated_at: created, comments: [] };
  repo.issues.push(issue);
  return JSON.stringify({ number: issue.number, title: issue.title, body: issue.body, state: issue.state, url: `http://localhost/${repo.owner.login}/${repo.name}/issues/${issue.number}` });
}

function callListIssues(args: Record<string, unknown>): string {
  const { repo } = lookupRepo(args);
  const state = typeof args.state === 'string' ? args.state.toLowerCase() : null;
  const out = repo.issues
    .filter((issue) => state === null || issue.state === state)
    .map((issue) => ({ number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
  return JSON.stringify(out);
}

function callCreatePullRequest(args: Record<string, unknown>): string {
  const { repo } = lookupRepo(args);
  const title = requireString(args, 'title');
  const body = typeof args.body === 'string' ? args.body : '';
  const headName = requireString(args, 'head');
  const baseName = requireString(args, 'base');
  const headSha = branchTip(repo, headName);
  const baseSha = branchTip(repo, baseName);
  if (headSha === undefined || baseSha === undefined) throw new Error('head or base branch not found');
  const mergeBase = mergeBaseOf(repo, headSha, baseSha);
  if (mergeBase === headSha) throw new Error('nothing to merge');
  const created = now();
  const number = repo.nextPull;
  repo.nextPull += 1;
  const pull: Pull = {
    id: String(number),
    number,
    title,
    body,
    state: 'open',
    head: { ref: `refs/heads/${headName}`, sha: headSha, label: `${repo.owner.login}:${headName}` },
    base: { ref: `refs/heads/${baseName}`, sha: baseSha, label: `${repo.owner.login}:${baseName}` },
    mergeBase,
    merged: false,
    mergeable: true,
    merged_at: null,
    merge_commit_sha: null,
    created_at: created,
    updated_at: created,
    user: repo.owner,
  };
  repo.pulls.push(pull);
  return JSON.stringify({ number: pull.number, title: pull.title, body: pull.body, state: pull.state, head: headName, base: baseName });
}

function callMergePullRequest(args: Record<string, unknown>): string {
  const { repo } = lookupRepo(args);
  const number = pickNumber(args, ['number', 'pull_number', 'pr_number', 'pull_request_number']);
  const pull = repo.pulls[number - 1];
  if (pull === undefined || pull.merged) throw new Error('Pull Request is not mergeable');
  const baseSha = branchTip(repo, pull.base.ref);
  const headSha = branchTip(repo, pull.head.ref);
  if (baseSha === undefined || headSha === undefined) throw new Error('Pull Request is not mergeable');
  if (!isAncestor(repo, baseSha, headSha) && !isAncestor(repo, headSha, baseSha)) throw new Error('Pull Request is not mergeable');
  const files = treeAt(repo, headSha);
  const commitSha = setTree(repo, pull.base.ref, files, `Merge pull request #${pull.number}`);
  pull.merged = true;
  pull.mergeable = true;
  pull.state = 'closed';
  pull.merged_at = now();
  pull.merge_commit_sha = commitSha;
  pull.base.sha = commitSha;
  pull.updated_at = pull.merged_at;
  return JSON.stringify({ merged: true, sha: commitSha });
}

function callGetFileContents(args: Record<string, unknown>): string {
  const { repo } = lookupRepo(args);
  const path = requireString(args, 'path');
  const ref = typeof args.ref === 'string' && args.ref !== '' ? args.ref : repo.defaultBranch;
  const tip = branchTip(repo, ref) ?? (repo.refs.has(ref) ? repo.refs.get(ref) : undefined);
  if (tip === undefined) throw new Error('Not Found');
  const tree = treeAt(repo, tip);
  const entry = tree.get(path);
  if (entry === undefined) throw new Error('Not Found');
  const content = entry.bytes.toString('base64');
  return JSON.stringify({ path, content, encoding: 'base64', sha: entry.sha });
}

function callListPullRequests(args: Record<string, unknown>): string {
  const { repo } = lookupRepo(args);
  const state = typeof args.state === 'string' ? args.state.toLowerCase() : null;
  const out = repo.pulls
    .filter((pull) => state === null || (state === 'closed' ? pull.state !== 'open' : pull.state === state))
    .map((pull) => ({
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.merged ? 'merged' : pull.state,
      head: pull.head.ref.replace(/^refs\/heads\//, ''),
      base: pull.base.ref.replace(/^refs\/heads\//, ''),
    }));
  return JSON.stringify(out);
}

const TOOL_HANDLERS_EXTRA: Record<string, (args: Record<string, unknown>) => string> = {
  create_issue: callCreateIssue,
  list_issues: callListIssues,
  create_pull_request: callCreatePullRequest,
  merge_pull_request: callMergePullRequest,
  get_file_contents: callGetFileContents,
  list_pull_requests: callListPullRequests,
};

Object.assign(TOOL_HANDLERS, TOOL_HANDLERS_EXTRA);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on('data', (chunk: Buffer) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(bytes);
      length += bytes.length;
    });
    req.on('end', () => resolve(Buffer.concat(chunks, length)));
    req.on('error', reject);
  });
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req.headers.authorization)) {
    sendJson(res, 401, jsonRpcError(null, -32001, 'Unauthorized'));
    return;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 200, jsonRpcError(null, -32700, 'Parse error'));
    return;
  }
  let request: { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  try {
    request = JSON.parse(raw.length === 0 ? '{}' : raw.toString('utf8')) as typeof request;
  } catch {
    sendJson(res, 200, jsonRpcError(null, -32700, 'Parse error'));
    return;
  }
  const id = request.id ?? null;
  const method = request.method ?? '';
  if (method === 'initialize') {
    sendJson(res, 200, jsonRpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
    }));
    return;
  }
  if (method === 'notifications/initialized') {
    res.writeHead(204, { 'X-GitHub-Request-Id': String(nextRequestId()) });
    res.end();
    return;
  }
  if (method === 'ping') {
    sendJson(res, 200, jsonRpcResult(id, {}));
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, jsonRpcResult(id, listTools()));
    return;
  }
  if (method === 'tools/call') {
    const params = request.params;
    if (params === undefined || params === null || typeof params !== 'object') {
      sendJson(res, 200, jsonRpcError(id, -32602, 'Invalid params'));
      return;
    }
    const name = typeof params.name === 'string' ? params.name : '';
    if (!TOOLS.some((tool) => tool.name === name)) {
      sendJson(res, 200, jsonRpcError(id, -32601, `Unknown tool: ${name}`));
      return;
    }
    const toolArgs = params.arguments !== undefined && params.arguments !== null ? params.arguments : {};
    try {
      const result = callTool(name, toolArgs);
      sendJson(res, 200, jsonRpcResult(id, result));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal error';
      sendJson(res, 200, jsonRpcResult(id, { content: [{ type: 'text', text: message }], isError: true }));
    }
    return;
  }
  sendJson(res, 200, jsonRpcError(id, -32601, 'Method not found'));
}