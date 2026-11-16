import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import { getRepo, repos, owner, nodeId, type Repo } from './store.ts';

// In-process REST adapter: reuse the existing operations without a loopback HTTP request.
export async function restOperation(method: string, path: string, body?: unknown): Promise<any> {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage;
  req.method = method; req.headers = { authorization: `Bearer ${process.env.MAKEFUN_SHOP_TOKEN}` };
  let status = 200, result: any;
  const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(text?: string) { result = text ? JSON.parse(text) : null; } } as unknown as ServerResponse;
  await handleRest(req, res, new URL('/api/v3' + path, 'http://entry'));
  if (status >= 400) throw new Error(result?.message ?? `HTTP ${status}`);
  return result;
}
export async function readJson(req: IncomingMessage): Promise<any> { let text = ''; for await (const b of req) text += b; return JSON.parse(text); }
export function sendJson(res: ServerResponse, status: number, body: unknown) { const text = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }); res.end(text); }
export function authorized(req: IncomingMessage) { const a = req.headers.authorization; return !!process.env.MAKEFUN_SHOP_TOKEN && (a === `Bearer ${process.env.MAKEFUN_SHOP_TOKEN}` || a === `token ${process.env.MAKEFUN_SHOP_TOKEN}`); }

type Field = { name: string; alias: string; args: any; selection: Field[]; directives: { name: string; args: any }[]; condition?: string; spread?: string };
class Parser {
  tokens: string[] = []; at = 0;
  fragments = new Map<string, { condition: string; selection: Field[] }>();
  constructor(text: string) {
    const re = /\s+|#[^\n]*|,|\.\.\.|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|[_A-Za-z][_0-9A-Za-z]*|[!$():=@\[\]{|}]/gy;
    let pos = 0;
    while (pos < text.length) { re.lastIndex = pos; const m = re.exec(text); if (!m) throw new Error(`Unexpected character at ${pos}`); pos = re.lastIndex; if (!/^[\s,#]/.test(m[0])) this.tokens.push(m[0]); }
  }
  peek() { return this.tokens[this.at]; }
  take(expected?: string) { const t = this.tokens[this.at++]; if (!t || (expected && expected !== t)) throw new Error(`Expected ${expected ?? 'token'}, got ${t ?? 'end'}`); return t; }
  name() { const n = this.take(); if (!/^[_A-Za-z]\w*$/.test(n)) throw new Error(`Expected name, got ${n}`); return n; }
  value(): any {
    const t = this.peek();
    if (t === '$') { this.take(); return { variable: this.name() }; }
    if (t === '{') { this.take(); const obj: any = {}; while (this.peek() !== '}') { const k = this.name(); this.take(':'); obj[k] = this.value(); } this.take('}'); return obj; }
    if (t === '[') { this.take(); const values = []; while (this.peek() !== ']') values.push(this.value()); this.take(']'); return values; }
    this.take(); if (t.startsWith('"')) return JSON.parse(t); if (t === 'null') return null; if (t === 'true' || t === 'false') return t === 'true'; if (/^-?\d/.test(t)) return Number(t); if (!/^\w+$/.test(t)) throw new Error('Bad value'); return t;
  }
  args() { const args: any = {}; if (this.peek() === '(') { this.take(); while (this.peek() !== ')') { const k = this.name(); this.take(':'); args[k] = this.value(); } this.take(')'); } return args; }
  directives() { const out = []; while (this.peek() === '@') { this.take(); out.push({ name: this.name(), args: this.args() }); } return out; }
  selection(): Field[] {
    this.take('{'); const fields: Field[] = [];
    while (this.peek() !== '}') {
      const f: Field = { name: '', alias: '', args: {}, selection: [], directives: [] };
      if (this.peek() === '...') { this.take(); const n = this.name(); if (n === 'on') f.condition = this.name(); else f.spread = n; }
      else { f.name = this.name(); f.alias = f.name; if (this.peek() === ':') { this.take(); f.name = this.name(); } f.args = this.args(); }
      f.directives = this.directives(); if (this.peek() === '{') f.selection = this.selection(); fields.push(f);
    }
    this.take('}'); return fields;
  }
  document() {
    const operations: { type: string; name?: string; defaults: any; selection: Field[] }[] = [];
    while (this.peek()) {
      if (this.peek() === 'fragment') { this.take(); const name = this.name(); this.take('on'); const condition = this.name(); this.fragments.set(name, { condition, selection: this.selection() }); continue; }
      const type = this.peek() === '{' ? 'query' : this.take(); if (!['query', 'mutation'].includes(type)) throw new Error('Expected query or mutation');
      const name = this.peek() !== '{' && this.peek() !== '(' ? this.name() : undefined, defaults: any = {};
      if (this.peek() === '(') { this.take(); while (this.peek() !== ')') { this.take('$'); const key = this.name(); this.take(':'); while (this.peek() && !['=', '$', ')'].includes(this.peek())) this.take(); if (this.peek() === '=') { this.take(); defaults[key] = this.value(); } } this.take(')'); }
      this.directives(); operations.push({ type, name, defaults, selection: this.selection() });
    }
    if (!operations.length) throw new Error('Missing operation'); return operations;
  }
}

// One static schema drives both selection validation and introspection.
const schema: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  User: { id: 'ID', login: 'String', name: 'String', email: 'String' },
  Repository: { id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User', defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
  Ref: { name: 'String' }, Node: { id: 'ID' },
  Issue: { id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', state: 'IssueState', body: 'String' },
  PullRequest: { id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState', merged: 'Boolean', headRefName: 'String', baseRefName: 'String', mergeable: 'MergeableState', files: 'FileConnection' },
  PullRequestChangedFile: { path: 'String', filename: 'String', additions: 'Int', deletions: 'Int' },
  IssueComment: { id: 'ID', body: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', endCursor: 'String', startCursor: 'String' },
  CreateIssuePayload: { issue: 'Issue' }, CloseIssuePayload: { issue: 'Issue' }, CreatePullRequestPayload: { pullRequest: 'PullRequest' }, MergePullRequestPayload: { pullRequest: 'PullRequest' }, AddCommentPayload: { commentEdge: 'CommentEdge', comment: 'IssueComment' }, CommentEdge: { node: 'IssueComment', cursor: 'String' },
  __Schema: { queryType: '__Type', mutationType: '__Type', subscriptionType: '__Type', types: '[__Type]', directives: '[__Directive]', description: 'String' },
  __Type: { kind: 'String', name: 'String', description: 'String', fields: '[__Field]', interfaces: '[__Type]', possibleTypes: '[__Type]', enumValues: '[__EnumValue]', inputFields: '[__InputValue]', ofType: '__Type', specifiedByURL: 'String', isOneOf: 'Boolean' },
  __Field: { name: 'String', description: 'String', args: '[__InputValue]', type: '__Type', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __InputValue: { name: 'String', description: 'String', type: '__Type', defaultValue: 'String', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __EnumValue: { name: 'String', description: 'String', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __Directive: { name: 'String', description: 'String', locations: '[String]', args: '[__InputValue]', isRepeatable: 'Boolean' },
};
for (const [prefix, type] of [['Issue', 'Issue'], ['PullRequest', 'PullRequest'], ['File', 'PullRequestChangedFile']]) {
  schema[prefix + 'Connection'] = { nodes: `[${type}]`, edges: `[${prefix}Edge]`, pageInfo: 'PageInfo', totalCount: 'Int' };
  schema[prefix + 'Edge'] = { node: type, cursor: 'String' };
}
const enums: Record<string, string[]> = { SearchType: ['ISSUE', 'REPOSITORY', 'USER'], IssueState: ['OPEN', 'CLOSED'], PullRequestState: ['OPEN', 'CLOSED', 'MERGED'], MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'], PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'], OrderDirection: ['ASC', 'DESC'], IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] };
const inputs: Record<string, Record<string, string>> = { CreateIssueInput: { repositoryId: 'ID', title: 'String', body: 'String' }, CloseIssueInput: { issueId: 'ID' }, CreatePullRequestInput: { repositoryId: 'ID', title: 'String', body: 'String', headRefName: 'String', baseRefName: 'String' }, MergePullRequestInput: { pullRequestId: 'ID', mergeMethod: 'PullRequestMergeMethod' }, AddCommentInput: { subjectId: 'ID', body: 'String' } };
function typeInfo(name: string): any {
  if (name.startsWith('[')) return { kind: 'LIST', name: null, ofType: () => typeInfo(name.slice(1, -1)) };
  return { name, kind: enums[name] ? 'ENUM' : inputs[name] ? 'INPUT_OBJECT' : name === 'Node' ? 'INTERFACE' : schema[name] ? 'OBJECT' : 'SCALAR', description: null, ofType: null, interfaces: [], possibleTypes: name === 'Node' ? ['Repository', 'Issue', 'PullRequest', 'IssueComment'].map(typeInfo) : null,
    fields: schema[name] ? () => Object.entries(schema[name]).filter(([n]) => !n.startsWith('__')).map(([n, t]) => ({ name: n, args: [], type: () => typeInfo(t), isDeprecated: false, deprecationReason: null })) : null,
    enumValues: enums[name]?.map(n => ({ name: n, isDeprecated: false, deprecationReason: null })) ?? null,
    inputFields: inputs[name] ? Object.entries(inputs[name]).map(([n, t]) => ({ name: n, type: () => typeInfo(t), defaultValue: null, isDeprecated: false })) : null };
}
const pathFor = (r: Repo) => `/repos/${encodeURIComponent(r.owner.login)}/${encodeURIComponent(r.name)}`;
function connection(values: any[], args: any) {
  const start = args.after ? Number(Buffer.from(args.after, 'base64url').toString().split(':')[1]) + 1 : 0;
  const first = Math.max(0, Math.min(100, args.first ?? 30)); const nodes = values.slice(start, start + first);
  const cursor = (i: number) => Buffer.from(`cursor:${i}`).toString('base64url');
  return { nodes, edges: nodes.map((node, i) => ({ node, cursor: cursor(start + i) })), totalCount: values.length, pageInfo: { hasNextPage: start + nodes.length < values.length, hasPreviousPage: start > 0, startCursor: nodes.length ? cursor(start) : null, endCursor: nodes.length ? cursor(start + nodes.length - 1) : null } };
}
function issueView(r: Repo, i: any) { return i ? { ...i, __typename: 'Issue', id: nodeId('issue', r, i.number), databaseId: i.id, state: i.state.toUpperCase() } : null; }
function pullView(r: Repo, p: any): any { return p ? { ...p, __typename: 'PullRequest', id: nodeId('pull', r, p.number), state: p.merged ? 'MERGED' : p.state.toUpperCase(), headRefName: p.head.ref, baseRefName: p.base.ref, mergeable: p.mergeable ? 'MERGEABLE' : 'CONFLICTING', files: async (a: any) => connection((await restOperation('GET', `${pathFor(r)}/pulls/${p.number}/files`)).map((f: any) => ({ ...f, path: f.filename })), a) } : null; }
function repoView(r: Repo | undefined): any {
  if (!r) return null;
  return { __typename: 'Repository', id: Buffer.from(`repo:${r.owner.login}/${r.name}`).toString('base64url'), databaseId: r.id, name: r.name, nameWithOwner: `${r.owner.login}/${r.name}`, owner: r.owner, defaultBranchRef: r.refs.has(`refs/heads/${r.defaultBranch}`) ? { name: r.defaultBranch } : null, viewerPermission: 'ADMIN', hasIssuesEnabled: true,
    issue: (a: any) => issueView(r, r.issues.get(a.number)), pullRequest: (a: any) => pullView(r, r.pulls.get(a.number)),
    issues: (a: any) => { const values = [...r.issues.values()].filter(i => !a.states || a.states.includes(i.state.toUpperCase())).sort((x, y) => (x.number - y.number) * (a.orderBy?.direction === 'DESC' ? -1 : 1)); return connection(values.map(i => issueView(r, i)), a); },
    pullRequests: (a: any) => connection([...r.pulls.values()].map(p => pullView(r, p)).filter(p => !a.states || a.states.includes(p.state)), a) };
}
function locate(id: string): { repo: Repo; kind: string; number: number } {
  const decoded = Buffer.from(id ?? '', 'base64url').toString();
  const m = /^(?:repo:(.+)|github-core-clone-01:(issue|pull|comment):(.+):(\d+))$/.exec(decoded);
  const r = m ? repos.get(m[1] ?? m[3]) : undefined;
  if (!r) throw new Error('Unknown global id'); return { repo: r, kind: m![1] ? 'repo' : m![2], number: Number(m![4]) };
}
function node(id: string): any { try { const { repo: r, kind, number } = locate(id); if (kind === 'repo') return repoView(r); if (kind === 'issue') return issueView(r, r.issues.get(number)); if (kind === 'pull') return pullView(r, r.pulls.get(number)); for (const i of r.issues.values()) { const c = i.comments.find(c => c.id === number); if (c) return { ...c, __typename: 'IssueComment', id }; } } catch {} return null; }
async function mutate(name: string, a: any) {
  const input = a.input ?? {}, { repo: r, kind, number } = locate(input.repositoryId ?? input.issueId ?? input.pullRequestId ?? input.subjectId);
  const path = pathFor(r);
  if (name === 'createIssue') { if (kind !== 'repo' || !input.title) throw new Error('repositoryId and title required'); const i = await restOperation('POST', `${path}/issues`, input); return { issue: issueView(r, r.issues.get(i.number)) }; }
  if (name === 'closeIssue') { if (kind !== 'issue') throw new Error('issueId required'); await restOperation('PATCH', `${path}/issues/${number}`, { state: 'closed' }); return { issue: issueView(r, r.issues.get(number)) }; }
  if (name === 'createPullRequest') { const p = await restOperation('POST', `${path}/pulls`, { title: input.title, body: input.body, head: input.headRefName?.replace(/^refs\/heads\//, ''), base: input.baseRefName?.replace(/^refs\/heads\//, '') }); return { pullRequest: pullView(r, r.pulls.get(p.number)) }; }
  if (name === 'mergePullRequest') { if (kind !== 'pull') throw new Error('pullRequestId required'); await restOperation('PUT', `${path}/pulls/${number}/merge`, { merge_method: 'squash' }); return { pullRequest: pullView(r, r.pulls.get(number)) }; }
  if (name === 'addComment') { const c = await restOperation('POST', `${path}/issues/${number}/comments`, { body: input.body }); const comment = { ...c, id: nodeId('comment', r, c.id) }; return { comment, commentEdge: { node: comment } }; }
  throw new Error(`Unknown mutation ${name}`);
}
function values(value: any, variables: any): any { if (Array.isArray(value)) return value.map(v => values(v, variables)); if (value && typeof value === 'object') { if ('variable' in value) return variables[value.variable]; return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, values(v, variables)])); } return value; }
async function execute(operation: any): Promise<any> {
  let parser: Parser, operations: ReturnType<Parser['document']>;
  try { if (typeof operation?.query !== 'string') throw new Error('query must be a string'); parser = new Parser(operation.query); operations = parser.document(); } catch (e) { return { errors: [{ message: (e as Error).message, extensions: { code: 'GRAPHQL_PARSE_FAILED' } }] }; }
  if (operation.operationName) operations = operations.filter(o => o.name === operation.operationName);
  if (!operations.length) return { errors: [{ message: 'Unknown operation' }] };
  const results = [];
  for (const op of operations) {
    const vars = { ...op.defaults, ...operation.variables }, errors: any[] = [];
    const project = async (object: any, type: string, fields: Field[], stack: string[] = []): Promise<any> => {
      if (object == null) return null;
      if (type.startsWith('[')) return Promise.all(object.map((item: any) => project(item, type.slice(1, -1), fields, stack)));
      type = object.__typename ?? type; const output: any = {};
      for (const f of fields) {
        if (f.directives.some(d => d.name === 'skip' && values(d.args, vars).if || d.name === 'include' && !values(d.args, vars).if)) continue;
        if (f.spread || f.condition) {
          const fragment = f.spread ? parser.fragments.get(f.spread) : f;
          if (!fragment || (f.spread && stack.includes(f.spread))) { errors.push({ message: 'Invalid fragment' }); continue; }
          if (fragment.condition === type || fragment.condition === 'Node') Object.assign(output, await project(object, type, fragment.selection, f.spread ? [...stack, f.spread] : stack));
          continue;
        }
        if (f.name === '__typename') { output[f.alias] = type; continue; }
        const target = schema[type]?.[f.name];
        if (!target) { errors.push({ message: `Cannot query field "${f.name}" on type "${type}"` }); continue; }
        try { let value = object[f.name]; if (typeof value === 'function') value = await value(values(f.args, vars)); output[f.alias] = f.selection.length ? await project(value, target, f.selection, stack) : value ?? null; }
        catch (e) { output[f.alias] = null; errors.push({ message: (e as Error).message }); }
      }
      return output;
    };
    const root: any = op.type === 'mutation' ? Object.fromEntries(Object.keys(schema.Mutation).map(n => [n, (a: any) => mutate(n, a)])) : { viewer: { ...owner, id: Buffer.from(`user:${owner.login}`).toString('base64url') }, repository: (a: any) => repoView(getRepo(a.owner, a.name)), node: (a: any) => node(a.id), __type: (a: any) => schema[a.name] || enums[a.name] || inputs[a.name] ? typeInfo(a.name) : null, __schema: { queryType: typeInfo('Query'), mutationType: typeInfo('Mutation'), subscriptionType: null, types: [...Object.keys(schema), ...Object.keys(enums), ...Object.keys(inputs), 'String', 'Int', 'Boolean', 'ID'].map(typeInfo), directives: [] } };
    const data = await project(root, op.type === 'mutation' ? 'Mutation' : 'Query', op.selection); results.push(errors.length ? { data, errors } : { data });
  }
  return results.length === 1 ? results[0] : results;
}
export async function handleGraphQL(req: IncomingMessage, res: ServerResponse) {
  if (!authorized(req)) { sendJson(res, 401, { message: 'Bad credentials' }); return; }
  try { const body = await readJson(req); sendJson(res, 200, Array.isArray(body) ? await Promise.all(body.map(execute)) : await execute(body)); }
  catch { sendJson(res, 200, { errors: [{ message: 'Malformed JSON', extensions: { code: 'GRAPHQL_PARSE_FAILED' } }] }); }
}
