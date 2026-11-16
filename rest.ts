import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  authorized,
  createRepo,
  deleteRepo,
  getRepo,
  hashObject,
  indexCommit,
  isAncestor,
  mergeBaseOf,
  nextRequestId,
  now,
  owner,
  parseTreeEntries,
  repos,
  resolveCommit,
  setTree,
  treeAt,
  type Comment,
  type FileEntry,
  type FileTree,
  type Issue,
  type Label,
  type Pull,
  type PullBranch,
  type Repo,
} from './store.ts';
import type { RequestQuery } from './app.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function baseHeaders(): Record<string, string> {
  return {
    'content-type': JSON_TYPE,
    'x-github-api-version': '2022-11-28',
    'x-github-request-id': nextRequestId(),
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  const headers = baseHeaders();
  headers['content-length'] = String(bytes.length);
  if (extra !== undefined) Object.assign(headers, extra);
  res.writeHead(status, headers);
  res.end(bytes);
}

export function sendCached(res: ServerResponse, status: number, bytes: Buffer, extra?: Record<string, string>): void {
  const headers = baseHeaders();
  headers['content-length'] = String(bytes.length);
  if (extra !== undefined) Object.assign(headers, extra);
  res.writeHead(status, headers);
  res.end(bytes);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  const headers = baseHeaders();
  headers['content-length'] = '0';
  res.writeHead(status, headers);
  res.end();
}

export class BadJsonError extends Error {}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
    length += bytes.length;
  }
  if (length === 0) return {};
  const body = Buffer.concat(chunks, length);
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>;
    return {};
  } catch {
    throw new BadJsonError('invalid JSON body');
  }
}

export function queryInt(query: RequestQuery, key: string, fallback: number): number {
  const raw = query.params.get(key);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function linkUrl(req: IncomingMessage, query: RequestQuery, segments: string[], page: number, perPage: number): string {
  const host = req.headers.host ?? 'localhost';
  const parts: string[] = [];
  for (const field of query.raw.split('&')) {
    if (field === '') continue;
    const key = field.slice(0, field.indexOf('=') < 0 ? field.length : field.indexOf('='));
    if (key === 'page' || key === 'per_page') continue;
    parts.push(field);
  }
  parts.push(`page=${page}`);
  parts.push(`per_page=${perPage}`);
  return `http://${host}/api/v3/${segments.join('/')}?${parts.join('&')}`;
}

export function paginate(req: IncomingMessage, res: ServerResponse, query: RequestQuery, segments: string[], items: unknown[]): unknown[] {
  const perPage = Math.min(queryInt(query, 'per_page', 30), 100);
  const page = queryInt(query, 'page', 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  if (page < lastPage) links.push(`<${linkUrl(req, query, segments, page + 1, perPage)}>; rel="next"`);
  if (page > 1) links.push(`<${linkUrl(req, query, segments, page - 1, perPage)}>; rel="prev"`);
  links.push(`<${linkUrl(req, query, segments, lastPage, perPage)}>; rel="last"`);
  res.setHeader('Link', links.join(', '));
  return slice;
}

function userJson(repo: Repo): Record<string, unknown> {
  return {
    login: repo.owner.login,
    id: repo.owner.id,
    node_id: Buffer.from(`github-core-clone-01:user:${repo.owner.login}`).toString('base64url'),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${repo.owner.login}`,
    html_url: `/users/${repo.owner.login}`,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo: Repo, host: string): Record<string, unknown> {
  const base = `http://${host}/api/v3/repos/${repo.owner.login}/${repo.name}`;
  return {
    id: repo.id,
    node_id: Buffer.from(`github-core-clone-01:repo:${repo.owner.login}/${repo.name}`).toString('base64url'),
    name: repo.name,
    full_name: `${repo.owner.login}/${repo.name}`,
    owner: userJson(repo),
    private: repo.private,
    description: repo.description,
    fork: false,
    url: base,
    html_url: `http://${host}/${repo.owner.login}/${repo.name}`,
    clone_url: `http://${host}/${repo.owner.login}/${repo.name}.git`,
    ssh_url: `git@${host}:${repo.owner.login}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: repo.issues.length,
    open_issues: repo.issues.length,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_downloads: true,
    has_pages: false,
    has_discussions: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    topics: [],
    license: null,
    languages_url: `${base}/languages`,
    permissions: { admin: true, push: true, pull: true },
  };
}

export function repoBuffer(repo: Repo, host: string): Buffer {
  if (repo.repoBuffer === null) repo.repoBuffer = Buffer.from(JSON.stringify(repoJson(repo, host)), 'utf8');
  return repo.repoBuffer;
}

export function invalidateRepoBuffer(repo: Repo): void {
  repo.repoBuffer = null;
}

export async function listUserRepos(req: IncomingMessage, res: ServerResponse, query: RequestQuery): Promise<void> {
  const host = req.headers.host ?? 'localhost';
  const all = [...repos.values()].sort((left, right) => left.id - right.id);
  const page = paginate(req, res, query, ['user', 'repos'], all);
  sendJson(res, 200, page.map((repo) => repoJson(repo as Repo, host)));
}

export async function createUserRepo(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const input = await readJsonBody(req);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', code: 'missing_field', field: 'name' }] });
    return;
  }
  const existing = [...repos.values()].find((repo) => repo.name === name);
  if (existing !== undefined) {
    sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', message: 'name already exists on this account' }] });
    return;
  }
  const repo = createRepo(name, input);
  if (input.auto_init === true) {
    const bytes = Buffer.from(`# ${name}\n`, 'utf8');
    const files = new Map([['README.md', { sha: hashObject('blob', bytes), bytes }]]);
    setTree(repo, `refs/heads/${repo.defaultBranch}`, files, 'Initial commit');
  }
  const host = req.headers.host ?? 'localhost';
  sendJson(res, 201, repoJson(repo, host));
}

export async function getRepoHandler(req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<void> {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const host = req.headers.host ?? 'localhost';
  sendCached(res, 200, repoBuffer(repo, host));
}

export async function updateRepoHandler(req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<void> {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const input = await readJsonBody(req);
  if (typeof input.name === 'string' && input.name.trim() !== '') repo.name = input.name.trim();
  if (typeof input.description === 'string') repo.description = input.description;
  if (typeof input.private === 'boolean') repo.private = input.private;
  if (typeof input.default_branch === 'string' && input.default_branch !== '') repo.defaultBranch = input.default_branch;
  repo.updated_at = repo.updated_at;
  invalidateRepoBuffer(repo);
  const host = req.headers.host ?? 'localhost';
  sendJson(res, 200, repoJson(repo, host));
}

export async function deleteRepoHandler(req: IncomingMessage, res: ServerResponse, owner: string, name: string): Promise<void> {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  deleteRepo(repo);
  sendEmpty(res, 204);
}

function treeEntries(repo: Repo, treeSha: string): { mode: string; name: string; sha: string }[] {
  const object = repo.objects.get(treeSha);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTreeEntries(object.bytes);
}

function lookupPath(repo: Repo, treeSha: string, path: string): { mode: string; name: string; sha: string } | null {
  if (path === '') return { mode: '40000', name: '', sha: treeSha };
  const segments = path.split('/');
  let current = treeSha;
  let found: { mode: string; name: string; sha: string } | null = null;
  for (let at = 0; at < segments.length; at += 1) {
    const match = treeEntries(repo, current).find((entry) => entry.name === segments[at]);
    if (match === undefined) return null;
    found = match;
    if (at < segments.length - 1) {
      if (match.mode !== '40000') return null;
      current = match.sha;
    }
  }
  return found;
}

function contentUrl(host: string, repo: Repo, path: string): string {
  const suffix = path === '' ? '' : `/${path}`;
  return `http://${host}/api/v3/repos/${repo.owner.login}/${repo.name}/contents${suffix}`;
}

function fileEntryJson(repo: Repo, host: string, path: string, entry: FileEntry): Record<string, unknown> {
  return {
    type: 'file',
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    sha: entry.sha,
    size: entry.bytes.length,
    url: contentUrl(host, repo, path),
    html_url: `http://${host}/${repo.owner.login}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `http://${host}/api/v3/repos/${repo.owner.login}/${repo.name}/git/blobs/${entry.sha}`,
    download_url: `http://${host}/${repo.owner.login}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
    content: entry.bytes.toString('base64'),
    encoding: 'base64',
  };
}

function dirEntryJson(repo: Repo, host: string, path: string, name: string, sha: string): Record<string, unknown> {
  const full = path === '' ? name : `${path}/${name}`;
  return {
    type: 'dir',
    name,
    path: full,
    sha,
    size: 0,
    url: contentUrl(host, repo, full),
    html_url: `http://${host}/${repo.owner.login}/${repo.name}/tree/${repo.defaultBranch}/${full}`,
    git_url: `http://${host}/api/v3/repos/${repo.owner.login}/${repo.name}/git/trees/${sha}`,
    download_url: null,
  };
}

function commitJson(repo: Repo, host: string, sha: string, message: string): Record<string, unknown> {
  const commit = repo.commits.get(sha);
  return {
    sha,
    node_id: Buffer.from(`github-core-clone-01:commit:${sha}`).toString('base64url'),
    url: `http://${host}/api/v3/repos/${repo.owner.login}/${repo.name}/git/commits/${sha}`,
    html_url: `http://${host}/${repo.owner.login}/${repo.name}/commit/${sha}`,
    author: { name: commit?.author.name ?? '', email: commit?.author.email ?? '', date: commit?.date ?? '' },
    committer: { name: commit?.author.name ?? '', email: commit?.author.email ?? '', date: commit?.date ?? '' },
    message,
    tree: { sha: commit?.tree ?? '', url: `http://${host}/api/v3/repos/${repo.owner.login}/${repo.name}/git/trees/${commit?.tree ?? ''}` },
    parents: (commit?.parents ?? []).map((parent) => ({ sha: parent, url: `http://${host}/api/v3/repos/${repo.owner.login}/${repo.name}/git/commits/${parent}` })),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
  };
}

export async function getContents(req: IncomingMessage, res: ServerResponse, owner: string, name: string, path: string, query: RequestQuery): Promise<void> {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const ref = query.params.get('ref') ?? repo.defaultBranch;
  const commitSha = resolveCommit(repo, ref);
  if (commitSha === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const commit = repo.commits.get(commitSha);
  if (commit === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const host = req.headers.host ?? 'localhost';
  const node = lookupPath(repo, commit.tree, path);
  if (node === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (node.mode === '40000') {
    const entries = treeEntries(repo, node.sha)
      .map((entry) => (entry.mode === '40000'
        ? dirEntryJson(repo, host, path, entry.name, entry.sha)
        : fileEntryJson(repo, host, path === '' ? entry.name : `${path}/${entry.name}`, { sha: entry.sha, bytes: repo.objects.get(entry.sha)?.bytes ?? Buffer.alloc(0) })))
      .sort((left, right) => (String(left.name) < String(right.name) ? -1 : 1));
    sendJson(res, 200, entries);
    return;
  }
  const blob = repo.objects.get(node.sha);
  if (blob === undefined || blob.type !== 'blob') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  sendJson(res, 200, fileEntryJson(repo, host, path, { sha: node.sha, bytes: blob.bytes }));
}

export async function putContents(req: IncomingMessage, res: ServerResponse, owner: string, name: string, path: string, query: RequestQuery): Promise<void> {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const input = await readJsonBody(req);
  const branchParam = query.params.get('branch');
  const branch = branchParam !== undefined && branchParam !== '' ? branchParam : typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
  if (resolveCommit(repo, branch) === undefined && (repo.commits.size > 0 || repo.refs.size > 0)) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (path === '') {
    sendJson(res, 422, { message: 'Invalid request.' });
    return;
  }
  const message = typeof input.message === 'string' ? input.message : `Update ${path}`;
  const bytes = typeof input.content === 'string' ? Buffer.from(input.content, 'base64') : Buffer.alloc(0);
  const current = treeAt(repo, branch);
  const existing = current.get(path);
  if (typeof input.sha === 'string' && input.sha !== '') {
    if (existing === undefined || existing.sha !== input.sha) {
      sendJson(res, 409, { message: 'Invalid request.', errors: [{ resource: 'Contents', code: 'sha_mismatch', message: 'sha does not match' }] });
      return;
    }
  }
  const files: FileTree = new Map(current);
  const blobSha = hashObject('blob', bytes);
  files.set(path, { sha: blobSha, bytes });
  const commitSha = setTree(repo, `refs/heads/${branch}`, files, message);
  invalidateRepoBuffer(repo);
  const host = req.headers.host ?? 'localhost';
  const entry: FileEntry = { sha: blobSha, bytes };
  sendJson(res, existing === undefined ? 201 : 200, {
    content: fileEntryJson(repo, host, path, entry),
    commit: commitJson(repo, host, commitSha, message),
  });
}

export async function deleteContents(req: IncomingMessage, res: ServerResponse, owner: string, name: string, path: string, query: RequestQuery): Promise<void> {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const input = await readJsonBody(req);
  const branchParam = query.params.get('branch');
  const branch = branchParam !== undefined && branchParam !== '' ? branchParam : typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
  if (resolveCommit(repo, branch) === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const message = typeof input.message === 'string' ? input.message : `Delete ${path}`;
  const current = treeAt(repo, branch);
  const existing = current.get(path);
  if (existing === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (typeof input.sha === 'string' && input.sha !== '' && existing.sha !== input.sha) {
    sendJson(res, 422, { message: 'Invalid request.', errors: [{ resource: 'Contents', code: 'sha_mismatch', message: 'sha does not match' }] });
    return;
  }
  const files: FileTree = new Map(current);
  files.delete(path);
  const commitSha = setTree(repo, `refs/heads/${branch}`, files, message);
  invalidateRepoBuffer(repo);
  const host = req.headers.host ?? 'localhost';
  sendJson(res, 200, { commit: commitJson(repo, host, commitSha, message) });
}

function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: Buffer.from(`github-core-clone-01:label:${repo.id}:${label.name}`).toString('base64url'),
    name: label.name,
    color: label.color,
    description: label.description,
    url: `http://localhost/api/v3/repos/${repo.owner.login}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
  };
}

function commentJson(repo: Repo, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`github-core-clone-01:comment:${repo.owner.login}/${repo.name}:${comment.id}`).toString('base64url'),
    body: comment.body,
    user: { login: comment.user.login, id: comment.user.id },
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    html_url: `http://localhost/${repo.owner.login}/${repo.name}/issues/${comment.id}#issuecomment-${comment.id}`,
    issue_url: `http://localhost/api/v3/repos/${repo.owner.login}/${repo.name}/issues/${comment.id}`,
  };
}

function issueJson(repo: Repo, host: string, issue: Issue): Record<string, unknown> {
  const base = `http://${host}/api/v3/repos/${repo.owner.login}/${repo.name}`;
  return {
    id: issue.id,
    node_id: Buffer.from(`github-core-clone-01:issue:${repo.owner.login}/${repo.name}:${issue.number}`).toString('base64url'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((label) => labelJson(repo, label)),
    assignee: null,
    assignees: [],
    user: { login: repo.owner.login, id: repo.owner.id },
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    url: `${base}/issues/${issue.number}`,
    html_url: `http://${host}/${repo.owner.login}/${repo.name}/issues/${issue.number}`,
    comments_url: `${base}/issues/${issue.number}/comments`,
    repository_url: base,
  };
}

function issueBuffer(repo: Repo, host: string, issue: Issue): Buffer {
  const cached = repo.issueBuffers.get(issue.number);
  if (cached !== undefined) return cached;
  const bytes = Buffer.from(JSON.stringify(issueJson(repo, host, issue)), 'utf8');
  repo.issueBuffers.set(issue.number, bytes);
  return bytes;
}

export function invalidateIssueBuffer(repo: Repo, number: number): void {
  repo.issueBuffers.delete(number);
}

export async function listIssues(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string, query: RequestQuery): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const state = query.params.get('state') ?? 'open';
  const labelFilter = query.params.get('labels');
  const wanted = labelFilter === undefined || labelFilter === ''
    ? undefined
    : new Set(labelFilter.split(',').map((value) => value.trim().toLowerCase()).filter((value) => value !== ''));
  const filtered = repo.issues.filter((issue) => {
    if (state !== 'all' && issue.state !== state) return false;
    if (wanted !== undefined) {
      for (const label of wanted) {
        if (!issue.labels.some((candidate) => candidate.name.toLowerCase() === label)) return false;
      }
    }
    return true;
  });
  const host = req.headers.host ?? 'localhost';
  const direction = query.params.get('direction');
  const ordered = direction === 'desc' ? [...filtered].reverse() : filtered;
  const page = paginate(req, res, query, ['repos', ownerName, name, 'issues'], ordered);
  sendJson(res, 200, page.map((issue) => issueJson(repo, host, issue as Issue)));
}

export async function createIssue(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const input = await readJsonBody(req);
  const title = typeof input.title === 'string' ? input.title : '';
  if (title.trim() === '') {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'missing_field', field: 'title' }] });
    return;
  }
  const created = now();
  const number = repo.nextIssue;
  repo.nextIssue += 1;
  const requested = Array.isArray(input.labels) ? input.labels.filter((value): value is string => typeof value === 'string') : [];
  const labels: Label[] = [];
  for (const labelName of requested) {
    const existing = repo.labels.get(labelName.toLowerCase());
    if (existing === undefined) {
      sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'invalid', field: 'labels', message: `Label "${labelName}" does not exist` }] });
      return;
    }
    labels.push(existing);
  }
  const issue: Issue = {
    id: number,
    number,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels,
    created_at: created,
    updated_at: created,
    comments: [],
  };
  repo.issues.push(issue);
  const host = req.headers.host ?? 'localhost';
  sendJson(res, 201, issueJson(repo, host, issue));
}

export async function getIssue(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string, number: number): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const issue = repo.issues[number - 1];
  if (issue === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const host = req.headers.host ?? 'localhost';
  sendCached(res, 200, issueBuffer(repo, host, issue));
}

export async function updateIssue(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string, number: number): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const issue = repo.issues[number - 1];
  if (issue === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const input = await readJsonBody(req);
  if (typeof input.title === 'string') issue.title = input.title;
  if (typeof input.body === 'string') issue.body = input.body;
  if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
  if (Array.isArray(input.labels)) {
    const labels: Label[] = [];
    for (const labelName of input.labels.filter((value): value is string => typeof value === 'string')) {
      const existing = repo.labels.get(labelName.toLowerCase());
      if (existing !== undefined) {
        labels.push(existing);
        continue;
      }
      const label: Label = { id: repo.nextLabel, name: labelName, color: 'ededed', description: '' };
      repo.nextLabel += 1;
      repo.labels.set(label.name.toLowerCase(), label);
      labels.push(label);
    }
    issue.labels = labels;
  }
  issue.updated_at = now();
  invalidateIssueBuffer(repo, issue.number);
  const host = req.headers.host ?? 'localhost';
  sendJson(res, 200, issueJson(repo, host, issue));
}

export async function listLabels(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string, query: RequestQuery): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const all = [...repo.labels.values()];
  const page = paginate(req, res, query, ['repos', ownerName, name, 'labels'], all);
  sendJson(res, 200, page.map((label) => labelJson(repo, label as Label)));
}

export async function createLabel(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const input = await readJsonBody(req);
  const labelName = typeof input.name === 'string' ? input.name.trim() : '';
  if (labelName === '') {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'missing_field', field: 'name' }] });
    return;
  }
  if (repo.labels.has(labelName.toLowerCase())) {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] });
    return;
  }
  const label: Label = {
    id: repo.nextLabel,
    name: labelName,
    color: typeof input.color === 'string' ? input.color : 'ededed',
    description: typeof input.description === 'string' ? input.description : '',
  };
  repo.nextLabel += 1;
  repo.labels.set(label.name.toLowerCase(), label);
  sendJson(res, 201, labelJson(repo, label));
}

export async function getLabel(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string, labelName: string): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const label = repo.labels.get(labelName.toLowerCase());
  if (label === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  sendJson(res, 200, labelJson(repo, label));
}

export async function updateLabel(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string, labelName: string): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const label = repo.labels.get(labelName.toLowerCase());
  if (label === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const input = await readJsonBody(req);
  if (typeof input.name === 'string' && input.name.trim() !== '') {
    repo.labels.delete(label.name.toLowerCase());
    label.name = input.name.trim();
    repo.labels.set(label.name.toLowerCase(), label);
  }
  if (typeof input.color === 'string') label.color = input.color;
  if (typeof input.description === 'string') label.description = input.description;
  sendJson(res, 200, labelJson(repo, label));
}

export async function deleteLabel(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string, labelName: string): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (!repo.labels.delete(labelName.toLowerCase())) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  sendEmpty(res, 204);
}

function findComment(repo: Repo, id: number): { issue: Issue; comment: Comment } | null {
  for (const issue of repo.issues) {
    for (const comment of issue.comments) {
      if (comment.id === id) return { issue, comment };
    }
  }
  return null;
}

export async function listComments(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string, number: number, query: RequestQuery): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const issue = repo.issues[number - 1];
  if (issue === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const page = paginate(req, res, query, ['repos', ownerName, name, 'issues', String(number), 'comments'], issue.comments);
  sendJson(res, 200, page.map((comment) => commentJson(repo, comment as Comment)));
}

export async function createComment(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string, number: number): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const issue = repo.issues[number - 1];
  if (issue === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const input = await readJsonBody(req);
  const body = typeof input.body === 'string' ? input.body : '';
  if (body.trim() === '') {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }] });
    return;
  }
  const created = now();
  const comment: Comment = {
    id: repo.nextComment,
    body,
    user: owner,
    created_at: created,
    updated_at: created,
  };
  repo.nextComment += 1;
  issue.comments.push(comment);
  issue.updated_at = created;
  invalidateIssueBuffer(repo, issue.number);
  sendJson(res, 201, commentJson(repo, comment));
}

export async function updateComment(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string, id: number): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const found = findComment(repo, id);
  if (found === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const input = await readJsonBody(req);
  if (typeof input.body === 'string') found.comment.body = input.body;
  found.comment.updated_at = now();
  invalidateIssueBuffer(repo, found.issue.number);
  sendJson(res, 200, commentJson(repo, found.comment));
}

export async function deleteComment(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string, id: number): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const found = findComment(repo, id);
  if (found === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  found.issue.comments = found.issue.comments.filter((comment) => comment.id !== id);
  found.issue.updated_at = now();
  invalidateIssueBuffer(repo, found.issue.number);
  sendEmpty(res, 204);
}

function branchJson(ref: string, sha: string, label: string): Record<string, unknown> {
  const plain = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  return { ref: plain, sha, label, user: { login: owner.login, id: owner.id } };
}

function pullJson(repo: Repo, host: string, pull: Pull): Record<string, unknown> {
  const base = `http://${host}/api/v3/repos/${repo.owner.login}/${repo.name}`;
  return {
    id: pull.id,
    node_id: Buffer.from(`github-core-clone-01:pull:${repo.owner.login}/${repo.name}:${pull.number}`).toString('base64url'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: branchJson(pull.head.ref, pull.head.sha, pull.head.label),
    base: branchJson(pull.base.ref, pull.base.sha, pull.base.label),
    user: { login: pull.user.login, id: pull.user.id },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    url: `${base}/pulls/${pull.number}`,
    html_url: `http://${host}/${repo.owner.login}/${repo.name}/pull/${pull.number}`,
    diff_url: `http://${host}/${repo.owner.login}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `http://${host}/${repo.owner.login}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `${base}/issues/${pull.number}`,
    commits_url: `${base}/pulls/${pull.number}/commits`,
    comments_url: `${base}/issues/${pull.number}/comments`,
    review_comments_url: `${base}/pulls/${pull.number}/comments`,
  };
}

function pullBuffer(repo: Repo, host: string, pull: Pull): Buffer {
  const cached = repo.pullBuffers.get(pull.number);
  if (cached !== undefined) return cached;
  const bytes = Buffer.from(JSON.stringify(pullJson(repo, host, pull)), 'utf8');
  repo.pullBuffers.set(pull.number, bytes);
  return bytes;
}

export function invalidatePullBuffer(repo: Repo, number: number): void {
  repo.pullBuffers.delete(number);
}

function branchTip(repo: Repo, name: string): string | undefined {
  const value = name.startsWith('refs/') ? name : `refs/heads/${name}`;
  return repo.refs.get(value);
}

export async function listPulls(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string, query: RequestQuery): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const state = query.params.get('state') ?? 'open';
  const filtered = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
  const host = req.headers.host ?? 'localhost';
  const page = paginate(req, res, query, ['repos', ownerName, name, 'pulls'], filtered);
  sendJson(res, 200, page.map((pull) => pullJson(repo, host, pull as Pull)));
}

export async function createPull(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const input = await readJsonBody(req);
  const title = typeof input.title === 'string' ? input.title : '';
  const headName = typeof input.head === 'string' ? input.head : '';
  const baseName = typeof input.base === 'string' ? input.base : repo.defaultBranch;
  if (title.trim() === '' || headName === '' || baseName === '') {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'missing_field', field: title.trim() === '' ? 'title' : 'head' }] });
    return;
  }
  const headSha = branchTip(repo, headName);
  const baseSha = branchTip(repo, baseName);
  if (headSha === undefined || baseSha === undefined) {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'invalid', field: 'head' }] });
    return;
  }
  if (headSha === baseSha) {
    sendJson(res, 409, { message: 'A pull request cannot have the same head and base.' });
    return;
  }
  const mergeBase = mergeBaseOf(repo, headSha, baseSha);
  if (mergeBase === headSha) {
    sendJson(res, 409, { message: 'There is nothing to merge.' });
    return;
  }
  const created = now();
  const number = repo.nextPull;
  repo.nextPull += 1;
  const head: PullBranch = { ref: `refs/heads/${headName.replace(/^refs\/heads\//, '')}`, sha: headSha, label: `${owner.login}:${headName.replace(/^refs\/heads\//, '')}` };
  const base: PullBranch = { ref: `refs/heads/${baseName.replace(/^refs\/heads\//, '')}`, sha: baseSha, label: `${owner.login}:${baseName.replace(/^refs\/heads\//, '')}` };
  const pull: Pull = {
    id: String(number),
    number,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    head,
    base,
    mergeBase,
    merged: false,
    mergeable: true,
    merged_at: null,
    merge_commit_sha: null,
    created_at: created,
    updated_at: created,
    user: owner,
  };
  repo.pulls.push(pull);
  const host = req.headers.host ?? 'localhost';
  sendJson(res, 201, pullJson(repo, host, pull));
}

export async function getPull(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string, number: number): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const pull = repo.pulls[number - 1];
  if (pull === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const host = req.headers.host ?? 'localhost';
  sendCached(res, 200, pullBuffer(repo, host, pull));
}

export async function updatePull(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string, number: number): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const pull = repo.pulls[number - 1];
  if (pull === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const input = await readJsonBody(req);
  if (typeof input.title === 'string') pull.title = input.title;
  if (typeof input.body === 'string') pull.body = input.body;
  if (input.state === 'open' || input.state === 'closed') pull.state = input.state;
  pull.updated_at = now();
  invalidatePullBuffer(repo, pull.number);
  const host = req.headers.host ?? 'localhost';
  sendJson(res, 200, pullJson(repo, host, pull));
}

function unifiedPatch(path: string, before: Buffer, after: Buffer): string {
  const oldLines = before.toString('utf8').split('\n');
  const newLines = after.toString('utf8').split('\n');
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let additions = 0;
  let deletions = 0;
  const limit = Math.min(oldLines.length, newLines.length);
  let index = 0;
  while (index < limit) {
    if (oldLines[index] === newLines[index]) {
      index += 1;
      continue;
    }
    break;
  }
  let oldAt = index;
  let newAt = index;
  while (oldAt < oldLines.length || newAt < newLines.length) {
    const oldLine = oldAt < oldLines.length ? oldLines[oldAt] : undefined;
    const newLine = newAt < newLines.length ? newLines[newAt] : undefined;
    if (oldLine !== undefined && newLine !== undefined && oldLine === newLine) {
      lines.push(` ${oldLine}`);
      oldAt += 1;
      newAt += 1;
      continue;
    }
    if (oldLine !== undefined) {
      lines.push(`-${oldLine}`);
      deletions += 1;
      oldAt += 1;
      continue;
    }
    if (newLine !== undefined) {
      lines.push(`+${newLine}`);
      additions += 1;
      newAt += 1;
    }
  }
  return { patch: lines.join('\n'), additions, deletions } as unknown as string;
}

export async function listPullFiles(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string, number: number): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const pull = repo.pulls[number - 1];
  if (pull === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const baseSha = branchTip(repo, pull.base.ref) ?? pull.base.sha;
  const headSha = branchTip(repo, pull.head.ref) ?? pull.head.sha;
  const mergeBase = mergeBaseOf(repo, headSha, baseSha);
  const baseTree = treeAt(repo, mergeBase);
  const headTree = treeAt(repo, headSha);
  const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
  const files: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const before = baseTree.get(path);
    const after = headTree.get(path);
    if (before !== undefined && after !== undefined && before.sha === after.sha) continue;
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    const beforeBytes = before?.bytes ?? Buffer.alloc(0);
    const afterBytes = after?.bytes ?? Buffer.alloc(0);
    const oldLines = beforeBytes.toString('utf8').split('\n');
    const newLines = afterBytes.toString('utf8').split('\n');
    let additions = 0;
    let deletions = 0;
    for (const line of newLines) if (line !== '') additions += 1;
    for (const line of oldLines) if (line !== '') deletions += 1;
    const patchLines: string[] = [`--- a/${path}`, `+++ b/${path}`];
    for (const line of oldLines) patchLines.push(`-${line}`);
    for (const line of newLines) patchLines.push(`+${line}`);
    files.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: after?.sha ?? before?.sha ?? '',
      blob_url: `http://localhost/api/v3/repos/${repo.owner.login}/${repo.name}/git/blobs/${after?.sha ?? before?.sha ?? ''}`,
      raw_url: `http://localhost/${repo.owner.login}/${repo.name}/raw/${pull.head.ref}/${path}`,
      contents_url: `http://localhost/api/v3/repos/${repo.owner.login}/${repo.name}/contents/${path}`,
      patch: patchLines.join('\n'),
    });
  }
  sendJson(res, 200, files);
}

export async function mergePull(req: IncomingMessage, res: ServerResponse, ownerName: string, name: string, number: number): Promise<void> {
  const repo = getRepo(ownerName, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const pull = repo.pulls[number - 1];
  if (pull === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (pull.merged) {
    sendJson(res, 405, { message: 'Pull Request is not mergeable' });
    return;
  }
  const baseSha = branchTip(repo, pull.base.ref);
  const headSha = branchTip(repo, pull.head.ref);
  if (baseSha === undefined || headSha === undefined) {
    sendJson(res, 405, { message: 'Pull Request is not mergeable' });
    return;
  }
  const baseIsAncestor = isAncestor(repo, baseSha, headSha);
  const headIsAncestor = isAncestor(repo, headSha, baseSha);
  if (!baseIsAncestor && !headIsAncestor) {
    const baseTree = treeAt(repo, pull.mergeBase);
    const currentTree = treeAt(repo, baseSha);
    const headTree = treeAt(repo, headSha);
    const paths = new Set<string>([...baseTree.keys(), ...currentTree.keys(), ...headTree.keys()]);
    for (const path of paths) {
      const original = baseTree.get(path);
      const current = currentTree.get(path);
      const head = headTree.get(path);
      const currentChanged = original === undefined ? current !== undefined : current === undefined || current.sha !== original.sha;
      const headChanged = original === undefined ? head !== undefined : head === undefined || head.sha !== original.sha;
      if (currentChanged && headChanged) {
        pull.mergeable = false;
        pull.updated_at = now();
        invalidatePullBuffer(repo, pull.number);
        sendJson(res, 405, { message: 'Pull Request is not mergeable' });
        return;
      }
    }
  }
  const files = treeAt(repo, headSha);
  const commitSha = setTree(repo, pull.base.ref, files, `Merge pull request #${pull.number}`);
  pull.merged = true;
  pull.mergeable = true;
  pull.state = 'closed';
  pull.merged_at = now();
  pull.merge_commit_sha = commitSha;
  pull.base.sha = commitSha;
  pull.updated_at = pull.merged_at;
  invalidatePullBuffer(repo, pull.number);
  invalidateRepoBuffer(repo);
  sendJson(res, 200, { sha: commitSha, merged: true, message: 'Pull Request successfully merged' });
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { message: 'Method Not Allowed' });
}

function parseNumber(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? -1 : parsed;
}

function identityJson(identity: { name: string; email: string; date: string }): Record<string, unknown> {
  return { name: identity.name, email: identity.email, date: identity.date };
}

export async function createGitRef(req: IncomingMessage, res: ServerResponse, repoOwner: string, repoName: string): Promise<void> {
  const repo = getRepo(repoOwner, repoName);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const input = await readJsonBody(req);
  const ref = typeof input.ref === 'string' && input.ref !== '' ? input.ref : '';
  const sha = typeof input.sha === 'string' ? input.sha : '';
  if (!ref.startsWith('refs/') || sha === '' || !repo.objects.has(sha)) {
    sendJson(res, 422, { message: 'Validation Failed' });
    return;
  }
  repo.refs.set(ref, sha);
  invalidateRepoBuffer(repo);
  sendJson(res, 201, { ref, object: { sha } });
}

export async function listGitRefs(req: IncomingMessage, res: ServerResponse, repoOwner: string, repoName: string): Promise<void> {
  const repo = getRepo(repoOwner, repoName);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } }));
  sendJson(res, 200, refs);
}

export async function listBranches(req: IncomingMessage, res: ServerResponse, repoOwner: string, repoName: string): Promise<void> {
  const repo = getRepo(repoOwner, repoName);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }));
  sendJson(res, 200, branches);
}

export async function listCommits(req: IncomingMessage, res: ServerResponse, repoOwner: string, repoName: string, query: RequestQuery): Promise<void> {
  const repo = getRepo(repoOwner, repoName);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const shaParam = query.params.get('sha');
  const branch = typeof shaParam === 'string' && shaParam !== '' ? shaParam : repo.defaultBranch;
  const tip = resolveCommit(repo, branch);
  if (tip === undefined) {
    sendJson(res, 200, []);
    return;
  }
  const commits: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  for (let at = 0; at < queue.length; at += 1) {
    const oid = queue[at];
    if (seen.has(oid)) continue;
    seen.add(oid);
    const indexed = repo.commits.get(oid) ?? (indexCommit(repo, oid) ? repo.commits.get(oid) : undefined);
    if (indexed === undefined) continue;
    const author = identityJson({ name: indexed.author.name, email: indexed.author.email, date: indexed.date });
    commits.push({
      sha: oid,
      commit: {
        message: indexed.message,
        author,
        committer: author,
      },
    });
    for (const parent of indexed.parents) queue.push(parent);
  }
  sendJson(res, 200, commits);
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, segments: string[], query: RequestQuery): Promise<void> {
  if (!authorized(req.headers.authorization)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  try {
  const method = req.method ?? 'GET';
  const count = segments.length;
  if (count === 0) {
    if (method !== 'GET') {
      methodNotAllowed(res);
      return;
    }
    const body = Buffer.from(JSON.stringify({ current_user_url: '/api/v3/user', user_repositories_url: '/api/v3/user/repos' }), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
      'x-oauth-scopes': '',
      'X-GitHub-Request-Id': String(nextRequestId()),
    });
    res.end(body);
    return;
  }
  if (segments[0] === 'meta') {
    if (count === 1 && method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return;
    }
    notFound(res);
    return;
  }
  if (segments[0] === 'user') {
    if (count === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        await listUserRepos(req, res, query);
        return;
      }
      if (method === 'POST') {
        await createUserRepo(req, res);
        return;
      }
      methodNotAllowed(res);
      return;
    }
    notFound(res);
    return;
  }
  if (segments[0] !== 'repos' || count < 3) {
    notFound(res);
    return;
  }
  const repoOwner = segments[1];
  const repoName = segments[2];
  const rest = segments.slice(3);
  if (rest.length === 0) {
    if (method === 'GET') {
      await getRepoHandler(req, res, repoOwner, repoName);
      return;
    }
    if (method === 'PATCH') {
      await updateRepoHandler(req, res, repoOwner, repoName);
      return;
    }
    if (method === 'DELETE') {
      await deleteRepoHandler(req, res, repoOwner, repoName);
      return;
    }
    methodNotAllowed(res);
    return;
  }
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      await getContents(req, res, repoOwner, repoName, path, query);
      return;
    }
    if (method === 'PUT') {
      await putContents(req, res, repoOwner, repoName, path, query);
      return;
    }
    if (method === 'DELETE') {
      await deleteContents(req, res, repoOwner, repoName, path, query);
      return;
    }
    methodNotAllowed(res);
    return;
  }
  if (rest[0] === 'git') {
    if (rest.length === 2 && rest[1] === 'refs') {
      if (method === 'GET') {
        await listGitRefs(req, res, repoOwner, repoName);
        return;
      }
      if (method === 'POST') {
        await createGitRef(req, res, repoOwner, repoName);
        return;
      }
      methodNotAllowed(res);
      return;
    }
    notFound(res);
    return;
  }
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      await listBranches(req, res, repoOwner, repoName);
      return;
    }
    notFound(res);
    return;
  }
  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      await listCommits(req, res, repoOwner, repoName, query);
      return;
    }
    notFound(res);
    return;
  }
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        await listIssues(req, res, repoOwner, repoName, query);
        return;
      }
      if (method === 'POST') {
        await createIssue(req, res, repoOwner, repoName);
        return;
      }
      methodNotAllowed(res);
      return;
    }
    if (rest.length === 2) {
      const number = parseNumber(rest[1]);
      if (number < 1) {
        notFound(res);
        return;
      }
      if (method === 'GET') {
        await getIssue(req, res, repoOwner, repoName, number);
        return;
      }
      if (method === 'PATCH') {
        await updateIssue(req, res, repoOwner, repoName, number);
        return;
      }
      methodNotAllowed(res);
      return;
    }
    if (rest.length === 3 && rest[1] === 'comments') {
      const id = parseNumber(rest[2]);
      if (id < 1) {
        notFound(res);
        return;
      }
      if (method === 'PATCH') {
        await updateComment(req, res, repoOwner, repoName, id);
        return;
      }
      if (method === 'DELETE') {
        await deleteComment(req, res, repoOwner, repoName, id);
        return;
      }
      methodNotAllowed(res);
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      const number = parseNumber(rest[1]);
      if (number < 1) {
        notFound(res);
        return;
      }
      if (method === 'GET') {
        await listComments(req, res, repoOwner, repoName, number, query);
        return;
      }
      if (method === 'POST') {
        await createComment(req, res, repoOwner, repoName, number);
        return;
      }
      methodNotAllowed(res);
      return;
    }
    notFound(res);
    return;
  }
  if (rest[0] === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') {
        await listLabels(req, res, repoOwner, repoName, query);
        return;
      }
      if (method === 'POST') {
        await createLabel(req, res, repoOwner, repoName);
        return;
      }
      methodNotAllowed(res);
      return;
    }
    if (rest.length === 2) {
      const labelName = rest[1];
      if (method === 'GET') {
        await getLabel(req, res, repoOwner, repoName, labelName);
        return;
      }
      if (method === 'PATCH') {
        await updateLabel(req, res, repoOwner, repoName, labelName);
        return;
      }
      if (method === 'DELETE') {
        await deleteLabel(req, res, repoOwner, repoName, labelName);
        return;
      }
      methodNotAllowed(res);
      return;
    }
    notFound(res);
    return;
  }
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        await listPulls(req, res, repoOwner, repoName, query);
        return;
      }
      if (method === 'POST') {
        await createPull(req, res, repoOwner, repoName);
        return;
      }
      methodNotAllowed(res);
      return;
    }
    if (rest.length === 2) {
      const number = parseNumber(rest[1]);
      if (number < 1) {
        notFound(res);
        return;
      }
      if (method === 'GET') {
        await getPull(req, res, repoOwner, repoName, number);
        return;
      }
      if (method === 'PATCH') {
        await updatePull(req, res, repoOwner, repoName, number);
        return;
      }
      methodNotAllowed(res);
      return;
    }
    if (rest.length === 3 && rest[2] === 'files') {
      const number = parseNumber(rest[1]);
      if (number < 1) {
        notFound(res);
        return;
      }
      if (method === 'GET') {
        await listPullFiles(req, res, repoOwner, repoName, number);
        return;
      }
      methodNotAllowed(res);
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      const number = parseNumber(rest[1]);
      if (number < 1) {
        notFound(res);
        return;
      }
      if (method === 'PUT') {
        await mergePull(req, res, repoOwner, repoName, number);
        return;
      }
      methodNotAllowed(res);
      return;
    }
    notFound(res);
    return;
  }
  notFound(res);
  } catch (error) {
    if (error instanceof BadJsonError) {
      sendJson(res, 400, { message: 'Bad Request' });
    } else if (!res.headersSent) {
      sendJson(res, 500, { message: 'Internal Server Error' });
    }
  }
}
