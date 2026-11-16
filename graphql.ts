import type { IncomingMessage, ServerResponse } from 'node:http';
import { invalidateIssueBuffer, invalidatePullBuffer } from './rest.ts';
import {
  authorized,
  getRepo,
  isAncestor,
  mergeBaseOf,
  nextRequestId,
  now,
  owner,
  repos,
  setTree,
  treeAt,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

type TokenKind = 'name' | 'string' | 'number' | 'punct' | 'variable' | 'spread';

interface Token {
  kind: TokenKind;
  value: string;
}

interface Selection {
  name: string;
  alias: string;
  args: Map<string, unknown>;
  selections: Selection[];
  spread: boolean;
  on: string | null;
}

interface Operation {
  type: 'query' | 'mutation';
  name: string;
  variables: Map<string, unknown>;
  selections: Selection[];
  fragments: Map<string, Selection[]>;
}

export function sendData(res: ServerResponse, data: unknown): void {
  const bytes = Buffer.from(JSON.stringify({ data }), 'utf8');
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'x-github-request-id': nextRequestId(),
    'x-github-api-version': '2022-11-28',
  });
  res.end(bytes);
}

export function sendErrors(res: ServerResponse, messages: string[]): void {
  const bytes = Buffer.from(JSON.stringify({ errors: messages.map((message) => ({ message })) }), 'utf8');
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'x-github-request-id': nextRequestId(),
    'x-github-api-version': '2022-11-28',
  });
  res.end(bytes);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',' || char === '\ufeff') {
      at += 1;
      continue;
    }
    if (char === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (char === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(at + 3, end) });
        at = end + 3;
        continue;
      }
      at += 1;
      let value = '';
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\') {
          at += 1;
          const escape = source[at];
          if (escape === 'n') value += '\n';
          else if (escape === 't') value += '\t';
          else if (escape === 'r') value += '\r';
          else if (escape === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(at + 1, at + 5), 16));
            at += 4;
          } else value += escape;
          at += 1;
          continue;
        }
        value += source[at];
        at += 1;
      }
      if (at >= source.length) throw new Error('unterminated string');
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (char === '$') {
      at += 1;
      const start = at;
      while (at < source.length && /[A-Za-z0-9_]/.test(source[at])) at += 1;
      tokens.push({ kind: 'variable', value: source.slice(start, at) });
      continue;
    }
    if (char === '.') {
      if (source.startsWith('...', at)) {
        tokens.push({ kind: 'punct', value: '...' });
        at += 3;
        continue;
      }
      throw new Error('unexpected token .');
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = at;
      while (at < source.length && /[A-Za-z0-9_]/.test(source[at])) at += 1;
      tokens.push({ kind: 'name', value: source.slice(start, at) });
      continue;
    }
    if (/[-0-9]/.test(char)) {
      const start = at;
      at += 1;
      while (at < source.length && /[0-9.eE+-]/.test(source[at])) at += 1;
      tokens.push({ kind: 'number', value: source.slice(start, at) });
      continue;
    }
    if ('{}()[]:!=|&'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      at += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)}`);
  }
  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private at = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.at];
  }

  next(): Token {
    const token = this.tokens[this.at];
    if (token === undefined) throw new Error('unexpected end of query');
    this.at += 1;
    return token;
  }

  expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value} but found ${token.value}`);
  }

  parseOperation(): Operation {
    const fragments = new Map<string, Selection[]>();
    let operation: Operation | null = null;
    while (this.peek() !== undefined) {
      if (this.peek()?.value === '{') {
        const selections = this.parseSelections();
        operation = { type: 'query', name: '', variables: new Map<string, unknown>(), selections, fragments };
        continue;
      }
      const token = this.next();
      if (token.kind === 'name' && token.value === 'fragment') {
        const name = this.next().value;
        this.expect('on');
        const typeName = this.next().value;
        const selections = this.parseSelections();
        fragments.set(name, selections);
        void typeName;
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        let name = '';
        if (this.peek()?.kind === 'name') name = this.next().value;
        const variables = new Map<string, unknown>();
        if (this.peek()?.value === '(') {
          const parsed = this.parseVariableDefinitions();
          for (const [key, value] of parsed) variables.set(key, value);
        }
        this.skipDirectives();
        const selections = this.parseSelections();
        operation = { type: token.value === 'mutation' ? 'mutation' : 'query', name, variables, selections, fragments };
        continue;
      }
      throw new Error(`unexpected token ${token.value}`);
    }
    if (operation === null) throw new Error('no operation found');
    return operation;
  }

  parseVariableDefinitions(): Map<string, unknown> {
    this.expect('(');
    const definitions = new Map<string, unknown>();
    while (this.peek() !== undefined && this.peek()?.value !== ')') {
      const variableToken = this.next();
      if (variableToken.kind !== 'variable') throw new Error(`expected variable but found ${variableToken.value}`);
      const name = variableToken.value;
      this.expect(':');
      this.parseType();
      if (this.peek()?.value === '=') {
        this.next();
        definitions.set(name, this.parseValue());
      } else {
        definitions.set(name, null);
      }
      this.skipDirectives();
    }
    this.expect(')');
    return definitions;
  }

  parseType(): void {
    if (this.peek()?.value === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek()?.value === '!') this.next();
  }

  skipDirectives(): void {
    while (this.peek()?.value === '@') {
      this.next();
      this.next();
      if (this.peek()?.value === '(') this.parseArguments();
    }
  }

  parseSelections(): Selection[] {
    const selections: Selection[] = [];
    this.expect('{');
    while (this.peek() !== undefined && this.peek()?.value !== '}') {
      if (this.peek()?.value === '...') {
        this.next();
        const token = this.next();
        if (token.value === 'on') {
          const typeName = this.next().value;
          this.skipDirectives();
          const nested = this.parseSelections();
          for (const selection of nested) selections.push({ ...selection, on: typeName });
          continue;
        }
        selections.push({ name: token.value, alias: token.value, args: new Map(), selections: [], spread: true, on: null });
        continue;
      }
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  parseSelection(): Selection {
    let name = this.next().value;
    let alias = name;
    if (this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    let args = new Map<string, unknown>();
    if (this.peek()?.value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections: Selection[] = [];
    if (this.peek()?.value === '{') selections = this.parseSelections();
    return { name, alias, args, selections, spread: false, on: null };
  }

  parseArguments(): Map<string, unknown> {
    this.expect('(');
    const args = new Map<string, unknown>();
    while (this.peek() !== undefined && this.peek()?.value !== ')') {
      const key = this.next().value;
      this.expect(':');
      args.set(key, this.parseValue());
    }
    this.expect(')');
    return args;
  }

  parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') {
      const value = Number(token.value);
      return Number.isNaN(value) ? token.value : value;
    }
    if (token.kind === 'variable') return { __variable: token.value };
    if (token.value === '[') {
      const list: unknown[] = [];
      while (this.peek() !== undefined && this.peek()?.value !== ']') list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (token.value === '{') {
      const object: Record<string, unknown> = {};
      while (this.peek() !== undefined && this.peek()?.value !== '}') {
        const key = this.next().value;
        this.expect(':');
        object[key] = this.parseValue();
      }
      this.expect('}');
      return object;
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    throw new Error(`unexpected value ${token.value}`);
  }
}

export function parseGraphQL(source: string): Operation {
  const parser = new Parser(tokenize(source));
  return parser.parseOperation();
}

interface FieldSpec {
  name: string;
  type: string;
  args: { name: string; type: string }[];
}

interface TypeSpec {
  name: string;
  kind: string;
  fields: FieldSpec[];
}

const STRING = 'String';
const INT = 'Int';
const BOOLEAN = 'Boolean';

const SCHEMA_TYPES: TypeSpec[] = [
  {
    name: 'Query',
    kind: 'OBJECT',
    fields: [
      { name: 'repository', type: 'Repository', args: [{ name: 'owner', type: STRING }, { name: 'name', type: STRING }] },
      { name: 'issue', type: 'Issue', args: [{ name: 'owner', type: STRING }, { name: 'name', type: STRING }, { name: 'number', type: INT }] },
      { name: 'pullRequest', type: 'PullRequest', args: [{ name: 'owner', type: STRING }, { name: 'name', type: STRING }, { name: 'number', type: INT }] },
      { name: 'viewer', type: 'User', args: [] },
    ],
  },
  {
    name: 'Mutation',
    kind: 'OBJECT',
    fields: [
      { name: 'createIssue', type: 'CreateIssuePayload', args: [{ name: 'input', type: 'CreateIssueInput!' }] },
      { name: 'closeIssue', type: 'CloseIssuePayload', args: [{ name: 'input', type: 'CloseIssueInput!' }] },
      { name: 'createPullRequest', type: 'CreatePullRequestPayload', args: [{ name: 'input', type: 'CreatePullRequestInput!' }] },
      { name: 'mergePullRequest', type: 'MergePullRequestPayload', args: [{ name: 'input', type: 'MergePullRequestInput!' }] },
      { name: 'addComment', type: 'AddCommentPayload', args: [{ name: 'input', type: 'AddCommentInput!' }] },
    ],
  },
  {
    name: 'Repository',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID', args: [] },
      { name: 'databaseId', type: INT, args: [] },
      { name: 'name', type: STRING, args: [] },
      { name: 'nameWithOwner', type: STRING, args: [] },
      { name: 'description', type: STRING, args: [] },
      { name: 'url', type: 'URI', args: [] },
      { name: 'createdAt', type: 'DateTime', args: [] },
      { name: 'updatedAt', type: 'DateTime', args: [] },
      { name: 'isPrivate', type: BOOLEAN, args: [] },
      { name: 'defaultBranchRef', type: 'Ref', args: [] },
      { name: 'owner', type: 'User', args: [] },
      { name: 'viewerPermission', type: 'RepositoryPermission', args: [] },
      { name: 'hasIssuesEnabled', type: BOOLEAN, args: [] },
      { name: 'issue', type: 'Issue', args: [{ name: 'number', type: INT }] },
      { name: 'issues', type: 'IssueConnection', args: [{ name: 'first', type: INT }, { name: 'after', type: STRING }, { name: 'states', type: '[IssueState!]' }] },
      { name: 'pullRequest', type: 'PullRequest', args: [{ name: 'number', type: INT }] },
      { name: 'pullRequests', type: 'PullRequestConnection', args: [{ name: 'first', type: INT }, { name: 'after', type: STRING }, { name: 'states', type: '[PullRequestState!]' }] },
      { name: 'labels', type: 'LabelConnection', args: [{ name: 'first', type: INT }] },
      { name: 'stargazerCount', type: INT, args: [] },
      { name: 'forkCount', type: INT, args: [] },
    ],
  },
  {
    name: 'Issue',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID', args: [] },
      { name: 'number', type: INT, args: [] },
      { name: 'title', type: STRING, args: [] },
      { name: 'body', type: STRING, args: [] },
      { name: 'state', type: 'IssueState', args: [] },
      { name: 'url', type: 'URI', args: [] },
      { name: 'createdAt', type: 'DateTime', args: [] },
      { name: 'updatedAt', type: 'DateTime', args: [] },
      { name: 'author', type: 'User', args: [] },
      { name: 'labels', type: 'LabelConnection', args: [] },
      { name: 'comments', type: 'CommentConnection', args: [] },
    ],
  },
  {
    name: 'PullRequest',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID', args: [] },
      { name: 'number', type: INT, args: [] },
      { name: 'title', type: STRING, args: [] },
      { name: 'body', type: STRING, args: [] },
      { name: 'state', type: 'PullRequestState', args: [] },
      { name: 'merged', type: BOOLEAN, args: [] },
      { name: 'mergeable', type: 'MergeableState', args: [] },
      { name: 'url', type: 'URI', args: [] },
      { name: 'headRefName', type: STRING, args: [] },
      { name: 'baseRefName', type: STRING, args: [] },
      { name: 'files', type: 'PullRequestChangedFileConnection', args: [{ name: 'first', type: INT }] },
      { name: 'commits', type: 'CommitConnection', args: [] },
    ],
  },
  {
    name: 'Label',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID', args: [] },
      { name: 'name', type: STRING, args: [] },
      { name: 'color', type: STRING, args: [] },
      { name: 'description', type: STRING, args: [] },
    ],
  },
  {
    name: 'User',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID', args: [] },
      { name: 'login', type: STRING, args: [] },
      { name: 'name', type: STRING, args: [] },
      { name: 'email', type: STRING, args: [] },
    ],
  },
  {
    name: 'Ref',
    kind: 'OBJECT',
    fields: [{ name: 'name', type: STRING, args: [] }],
  },
  {
    name: 'Comment',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID', args: [] },
      { name: 'body', type: STRING, args: [] },
      { name: 'author', type: 'User', args: [] },
      { name: 'createdAt', type: 'DateTime', args: [] },
    ],
  },
  {
    name: 'PageInfo',
    kind: 'OBJECT',
    fields: [
      { name: 'hasNextPage', type: BOOLEAN, args: [] },
      { name: 'hasPreviousPage', type: BOOLEAN, args: [] },
      { name: 'startCursor', type: STRING, args: [] },
      { name: 'endCursor', type: STRING, args: [] },
    ],
  },
  {
    name: 'PullRequestChangedFile',
    kind: 'OBJECT',
    fields: [
      { name: 'filename', type: STRING, args: [] },
      { name: 'status', type: STRING, args: [] },
      { name: 'additions', type: INT, args: [] },
      { name: 'deletions', type: INT, args: [] },
      { name: 'changes', type: INT, args: [] },
    ],
  },
  {
    name: 'Commit',
    kind: 'OBJECT',
    fields: [
      { name: 'oid', type: 'String', args: [] },
      { name: 'message', type: STRING, args: [] },
    ],
  },
  {
    name: 'MergeResult',
    kind: 'OBJECT',
    fields: [
      { name: 'merged', type: BOOLEAN, args: [] },
      { name: 'sha', type: STRING, args: [] },
    ],
  },
  {
    name: 'SearchType',
    kind: 'ENUM',
    fields: [],
  },
  {
    name: 'CreateIssuePayload',
    kind: 'OBJECT',
    fields: [{ name: 'issue', type: 'Issue', args: [] }],
  },
  {
    name: 'CloseIssuePayload',
    kind: 'OBJECT',
    fields: [{ name: 'issue', type: 'Issue', args: [] }],
  },
  {
    name: 'CreatePullRequestPayload',
    kind: 'OBJECT',
    fields: [{ name: 'pullRequest', type: 'PullRequest', args: [] }],
  },
  {
    name: 'MergePullRequestPayload',
    kind: 'OBJECT',
    fields: [{ name: 'pullRequest', type: 'PullRequest', args: [] }],
  },
  {
    name: 'AddCommentPayload',
    kind: 'OBJECT',
    fields: [{ name: 'commentEdge', type: 'IssueCommentEdge', args: [] }],
  },
  {
    name: 'IssueCommentEdge',
    kind: 'OBJECT',
    fields: [{ name: 'node', type: 'IssueComment', args: [] }],
  },
  {
    name: 'IssueComment',
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID', args: [] },
      { name: 'body', type: STRING, args: [] },
    ],
  },
];

export function schemaIntrospection(): Record<string, unknown> {
  return {
    queryType: { name: 'Query' },
    mutationType: { name: 'Mutation' },
    subscriptionType: null,
    directives: [],
    types: SCHEMA_TYPES.map((type) => ({
      name: type.name,
      kind: type.kind,
      description: null,
      fields: type.fields.map((field) => ({
        name: field.name,
        description: null,
        args: field.args.map((arg) => ({ name: arg.name, description: null, type: { kind: 'SCALAR', name: arg.type, ofType: null } })),
        type: { kind: type.fields.length > 0 ? 'OBJECT' : 'SCALAR', name: field.type, ofType: null },
      })),
      inputFields: null,
      interfaces: [],
      enumValues: null,
      possibleTypes: null,
    })),
  };
}

function enumValuesFor(name: string): Record<string, unknown>[] {
  if (name === 'SearchType') {
    return [{ name: 'ISSUE', description: null, isDeprecated: false, deprecationReason: null }];
  }
  return [];
}

export function typeIntrospection(name: string): Record<string, unknown> | null {
  const type = SCHEMA_TYPES.find((candidate) => candidate.name === name);
  if (type === undefined) return null;
  const isEnum = type.kind === 'ENUM';
  return {
    name: type.name,
    kind: type.kind,
    description: null,
    fields: type.fields.map((field) => ({
      name: field.name,
      description: null,
      args: field.args.map((arg) => ({ name: arg.name, description: null, type: { kind: 'SCALAR', name: arg.type, ofType: null } })),
      type: { kind: isEnum ? 'ENUM' : 'OBJECT', name: field.type, ofType: null },
    })),
    inputFields: null,
    interfaces: [],
    enumValues: isEnum ? enumValuesFor(name) : null,
    possibleTypes: null,
  };
}

export function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

export function globalId(kind: string, n: number): string {
  return Buffer.from(`${kind}:${n}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: unknown): { kind: string; n: number } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    const kind = text.slice(0, colon);
    const n = Number.parseInt(text.slice(colon + 1), 10);
    if (!Number.isFinite(n)) return null;
    return { kind, n };
  } catch {
    return null;
  }
}

export function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return 0;
    const index = Number.parseInt(text.slice(7), 10);
    return Number.isFinite(index) && index >= 0 ? index : 0;
  } catch {
    return 0;
  }
}

export interface Connection {
  nodes: unknown[];
  totalCount: number;
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
}

export function applyConnection(items: unknown[], args: Map<string, unknown>): Connection {
  const firstRaw = args.get('first');
  const first = typeof firstRaw === 'number' && firstRaw >= 0 ? firstRaw : items.length;
  const afterRaw = args.get('after');
  const after = afterRaw === undefined || afterRaw === null ? 0 : decodeCursor(afterRaw) + 1;
  const start = Math.min(after, items.length);
  const end = Math.min(start + first, items.length);
  const nodes = items.slice(start, end);
  return {
    nodes,
    totalCount: items.length,
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: nodes.length > 0 ? encodeCursor(start) : null,
      endCursor: nodes.length > 0 ? encodeCursor(end - 1) : null,
    },
  };
}

export interface ResolverContext {
  variables: Map<string, unknown>;
  fragments: Map<string, Selection[]>;
}

export function resolveVariable(value: unknown, context: ResolverContext): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && '__variable' in (value as Record<string, unknown>)) {
    const name = String((value as Record<string, unknown>).__variable);
    return context.variables.get(name) ?? null;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveVariable(entry, context));
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) output[key] = resolveVariable(entry, context);
    return output;
  }
  return value;
}

export function resolveArgs(args: Map<string, unknown>, context: ResolverContext): Map<string, unknown> {
  const resolved = new Map<string, unknown>();
  for (const [key, value] of args) resolved.set(key, resolveVariable(value, context));
  return resolved;
}

function expandSelections(selections: Selection[], context: ResolverContext): Selection[] {
  const output: Selection[] = [];
  for (const selection of selections) {
    if (selection.spread) {
      const fragment = context.fragments.get(selection.name);
      if (fragment !== undefined) output.push(...expandSelections(fragment, context));
      continue;
    }
    output.push(selection);
  }
  return output;
}

function isConnection(value: unknown): value is { nodes: unknown[]; totalCount: number } {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.nodes) && typeof record.totalCount === 'number';
}

export function resolveSelections(value: unknown, selections: Selection[], context: ResolverContext, typeName: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const selection of expandSelections(selections, context)) {
    if (selection.name === '__typename') {
      output[selection.alias] = typeof record.__typename === 'string' ? record.__typename : typeName;
      continue;
    }
    if (typeName === 'Repository' && (selection.name === 'issue' || selection.name === 'pullRequest')) {
      const repo = (record as { __repo: Repo }).__repo;
      const number = argNumber(resolveArgs(selection.args, context), 'number');
      let target: Record<string, unknown> | null = null;
      if (selection.name === 'issue') {
        const issue = repo.issues[number - 1];
        target = issue === undefined ? null : issueValue(repo, issue);
      } else {
        const pull = repo.pulls[number - 1];
        target = pull === undefined ? null : pullRequestValue(repo, pull);
      }
      output[selection.alias] = target === null ? null : resolveSelections(target, selection.selections, context, nodeType(target));
      continue;
    }
    if (isConnection(record)) {
      output[selection.alias] = projectConnection(record, selection, context);
      continue;
    }
    const field = record[selection.name];
    if (field === undefined && !(selection.name in record)) {
      throw new Error(`Cannot query field "${selection.name}" on type "${typeName}"`);
    }
    if (isConnection(field)) {
      output[selection.alias] = projectConnection(field, selection, context);
      continue;
    }
    if (Array.isArray(field)) {
      output[selection.alias] = field.map((element) =>
        selection.selections.length === 0 ? element : resolveSelections(element, selection.selections, context, nodeType(element))
      );
      continue;
    }
    if (selection.selections.length === 0) {
      output[selection.alias] = field ?? null;
      continue;
    }
    output[selection.alias] = resolveSelections(field, selection.selections, context, nodeType(field));
  }
  return output;
}

function projectConnection(record: { nodes: unknown[]; totalCount: number }, selection: Selection, context: ResolverContext): unknown {
  const args = resolveArgs(selection.args, context);
  const filteredNodes = applyConnectionFilters(record.nodes, args);
  const connection = applyConnection(filteredNodes, args);
  const nodeSelections = selection.selections.find((child) => child.name === 'nodes')?.selections ?? [];
  const projected = connection.nodes.map((node) => resolveSelections(node, nodeSelections, context, nodeType(node)));
  if (selection.selections.length === 0) return projected;
  const wantsEdges = selection.selections.some((child) => child.name === 'edges');
  const wantsNodes = selection.selections.some((child) => child.name === 'nodes');
  const wantsPageInfo = selection.selections.some((child) => child.name === 'pageInfo');
  const wantsTotal = selection.selections.some((child) => child.name === 'totalCount');
  const result: Record<string, unknown> = {};
  if (wantsNodes) result.nodes = projected;
  if (wantsEdges) {
    const edgeSelections = selection.selections.find((child) => child.name === 'edges');
    const wantsCursor = edgeSelections?.selections.some((child) => child.name === 'cursor') ?? false;
    result.edges = connection.nodes.map((node, index) => {
      const edgeValue = wantsCursor ? { cursor: encodeCursor(index), node } : { node };
      return resolveSelections(edgeValue, edgeSelections?.selections ?? [], context, 'PullRequestReviewEdge');
    });
  }
  if (wantsPageInfo) {
    const pageInfoSelections = selection.selections.find((child) => child.name === 'pageInfo')?.selections ?? [];
    result.pageInfo = resolveSelections(connection.pageInfo, pageInfoSelections, context, 'PageInfo');
  }
  if (wantsTotal) result.totalCount = connection.totalCount;
  return result;
}

function applyConnectionFilters(nodes: unknown[], args: Map<string, unknown>): unknown[] {
  let result = nodes;
  const states = args.get('states');
  if (Array.isArray(states) && states.length > 0) {
    const allowed = new Set<string>(states.map((state) => {
      const value = (state as Record<string, unknown> | null)?.__enum ?? state;
      return String(value).toUpperCase();
    }));
    result = result.filter((node) => {
      const state = (node as Record<string, unknown>)?.state;
      return typeof state === 'string' && allowed.has(state.toUpperCase());
    });
  }
  const orderBy = args.get('orderBy');
  if (orderBy !== null && typeof orderBy === 'object') {
    const direction = (orderBy as Record<string, unknown>)?.direction;
    const directionValue = (direction as Record<string, unknown> | null)?.__enum ?? direction;
    if (directionValue === 'DESC') result = [...result].reverse();
  }
  return result;
}

function nodeType(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    const typename = (value as Record<string, unknown>).__typename;
    if (typeof typename === 'string') return typename;
  }
  return 'Object';
}

export function userValue(login: string, id: number): Record<string, unknown> {
  return { __typename: 'User', id: globalId('User', id), login, name: login, email: `${login}@example.invalid` };
}

export function labelValue(label: { id: number; name: string; color: string; description: string }): Record<string, unknown> {
  return { __typename: 'Label', id: globalId('Label', label.id), name: label.name, color: label.color, description: label.description };
}

export function commentValue(comment: { id: number; body: string; created_at: string; user: { login: string; id: number } }): Record<string, unknown> {
  return {
    __typename: 'Comment',
    id: globalId('Comment', comment.id),
    body: comment.body,
    createdAt: comment.created_at,
    author: userValue(comment.user.login, comment.user.id),
  };
}

export function issueValue(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: globalId('Issue', issue.id),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    url: `http://localhost/${repo.owner.login}/${repo.name}/issues/${issue.number}`,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    author: userValue(repo.owner.login, repo.owner.id),
    labels: { nodes: issue.labels.map(labelValue), totalCount: issue.labels.length },
    comments: { nodes: issue.comments.map(commentValue), totalCount: issue.comments.length },
  };
}

function branchTip(repo: Repo, name: string): string | undefined {
  const value = name.startsWith('refs/') ? name : `refs/heads/${name}`;
  return repo.refs.get(value);
}

function diffFiles(repo: Repo, mergeBaseSha: string, headSha: string): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const baseTree = treeAt(repo, mergeBaseSha);
  const headTree = treeAt(repo, headSha);
  const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
  const files: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  for (const path of [...paths].sort()) {
    const before = baseTree.get(path);
    const after = headTree.get(path);
    if (before !== undefined && after !== undefined && before.sha === after.sha) continue;
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    const oldLines = (before?.bytes ?? Buffer.alloc(0)).toString('utf8').split('\n');
    const newLines = (after?.bytes ?? Buffer.alloc(0)).toString('utf8').split('\n');
    let additions = 0;
    let deletions = 0;
    for (const line of newLines) if (line !== '') additions += 1;
    for (const line of oldLines) if (line !== '') deletions += 1;
    files.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return files;
}

function pullBranchCommits(repo: Repo, mergeBaseSha: string, headSha: string): { oid: string; message: string }[] {
  const commits: { oid: string; message: string }[] = [];
  const queue: string[] = [headSha];
  const seen = new Set<string>();
  for (let at = 0; at < queue.length; at += 1) {
    const oid = queue[at];
    if (oid === mergeBaseSha || seen.has(oid)) continue;
    seen.add(oid);
    const commit = repo.commits.get(oid);
    if (commit === undefined) continue;
    commits.push({ oid, message: commit.message });
    for (const parent of commit.parents) queue.push(parent);
  }
  return commits;
}

export function pullRequestValue(repo: Repo, pull: Pull): Record<string, unknown> {
  const baseSha = branchTip(repo, pull.base.ref) ?? pull.base.sha;
  const headSha = branchTip(repo, pull.head.ref) ?? pull.head.sha;
  const mergeBase = mergeBaseOf(repo, headSha, baseSha);
  const files = diffFiles(repo, mergeBase, headSha);
  const commits = pullBranchCommits(repo, mergeBase, headSha);
  const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
  return {
    __typename: 'PullRequest',
    id: globalId('PullRequest', Number(pull.id)),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state,
    merged: pull.merged,
    mergeable: pull.mergeable ? 'MERGEABLE' : 'CONFLICTING',
    url: `http://localhost/${repo.owner.login}/${repo.name}/pull/${pull.number}`,
    headRefName: pull.head.ref.replace(/^refs\/heads\//, ''),
    baseRefName: pull.base.ref.replace(/^refs\/heads\//, ''),
    files: { nodes: files.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename, filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes })), totalCount: files.length },
    commits: { nodes: commits, totalCount: commits.length },
  };
}

export function repositoryValue(repo: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository',
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner.login}/${repo.name}`,
    description: repo.description,
    url: `http://localhost/${repo.owner.login}/${repo.name}`,
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
    isPrivate: repo.private,
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    owner: userValue(repo.owner.login, repo.owner.id),
    issues: { nodes: repo.issues.map((issue) => issueValue(repo, issue)), totalCount: repo.issues.length },
    pullRequests: { nodes: repo.pulls.map((pull) => pullRequestValue(repo, pull)), totalCount: repo.pulls.length },
    labels: { nodes: [...repo.labels.values()].map(labelValue), totalCount: repo.labels.size },
    stargazerCount: 0,
    forkCount: 0,
    __repo: repo,
  };
}

function argString(args: Map<string, unknown>, name: string): string {
  const value = args.get(name);
  return typeof value === 'string' ? value : '';
}

function argNumber(args: Map<string, unknown>, name: string): number {
  const value = args.get(name);
  return typeof value === 'number' ? value : 0;
}

function resolveField(value: unknown, selection: Selection, context: ResolverContext, typeName: string): unknown {
  return resolveSelections(value, selection.selections, context, typeName);
}

export function resolveQuery(operation: Operation, context: ResolverContext): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const selection of expandSelections(operation.selections, context)) {
    if (selection.name === '__schema') {
      data[selection.alias] = resolveField(schemaIntrospection(), selection, context, '__Schema');
      continue;
    }
    if (selection.name === '__type') {
      const args = resolveArgs(selection.args, context);
      const typeName = argString(args, 'name');
      const introspection = typeIntrospection(typeName);
      data[selection.alias] = introspection === null ? null : resolveField(introspection, selection, context, '__Type');
      continue;
    }
    if (selection.name === 'viewer') {
      data[selection.alias] = resolveField(userValue(owner.login, owner.id), selection, context, 'User');
      continue;
    }
    if (selection.name === 'node') {
      const args = resolveArgs(selection.args, context);
      const parsed = parseGlobalId(args.get('id'));
      let target: Record<string, unknown> | null = null;
      if (parsed !== null) {
        const { kind, n } = parsed;
        if (kind === 'Repository') {
          for (const repo of repos.values()) {
            if (repo.id === n) { target = repositoryValue(repo); break; }
          }
        } else if (kind === 'Issue' || kind === 'PullRequest') {
          for (const repo of repos.values()) {
            if (kind === 'Issue') {
              const issue = repo.issues.find((item) => item.id === n);
              if (issue !== undefined) { target = issueValue(repo, issue); break; }
            } else {
              const pull = repo.pulls.find((item) => Number(item.id) === n);
              if (pull !== undefined) { target = pullRequestValue(repo, pull); break; }
            }
          }
        }
      }
      data[selection.alias] = target === null ? null : resolveField(target, selection, context, nodeType(target));
      continue;
    }
    if (selection.name === 'repository') {
      const args = resolveArgs(selection.args, context);
      const repo = getRepo(argString(args, 'owner'), argString(args, 'name'));
      data[selection.alias] = repo === undefined ? null : resolveField(repositoryValue(repo), selection, context, 'Repository');
      continue;
    }
    if (selection.name === 'issue') {
      const args = resolveArgs(selection.args, context);
      const repo = getRepo(argString(args, 'owner'), argString(args, 'name'));
      const issue = repo === undefined ? undefined : repo.issues[argNumber(args, 'number') - 1];
      data[selection.alias] = repo === undefined || issue === undefined ? null : resolveField(issueValue(repo, issue), selection, context, 'Issue');
      continue;
    }
    if (selection.name === 'pullRequest') {
      const args = resolveArgs(selection.args, context);
      const repo = getRepo(argString(args, 'owner'), argString(args, 'name'));
      const pull = repo === undefined ? undefined : repo.pulls[argNumber(args, 'number') - 1];
      data[selection.alias] = repo === undefined || pull === undefined ? null : resolveField(pullRequestValue(repo, pull), selection, context, 'PullRequest');
      continue;
    }
    throw new Error(`Cannot query field "${selection.name}" on type "Query"`);
  }
  return data;
}

function inputObject(selection: Selection, context: ResolverContext): Record<string, unknown> {
  const args = resolveArgs(selection.args, context);
  const input = args.get('input');
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function repoById(parsed: { kind: string; n: number } | null): Repo | undefined {
  if (parsed === null || parsed.kind !== 'Repository') return undefined;
  for (const repo of repos.values()) {
    if (repo.id === parsed.n) return repo;
  }
  return undefined;
}

function issueById(parsed: { kind: string; n: number } | null): { repo: Repo; issue: Issue } | undefined {
  if (parsed === null || parsed.kind !== 'Issue') return undefined;
  for (const repo of repos.values()) {
    const issue = repo.issues.find((item) => item.id === parsed.n);
    if (issue !== undefined) return { repo, issue };
  }
  return undefined;
}

function pullById(parsed: { kind: string; n: number } | null): { repo: Repo; pull: Pull } | undefined {
  if (parsed === null || parsed.kind !== 'PullRequest') return undefined;
  for (const repo of repos.values()) {
    const pull = repo.pulls.find((item) => Number(item.id) === parsed.n);
    if (pull !== undefined) return { repo, pull };
  }
  return undefined;
}

export function resolveMutation(operation: Operation, context: ResolverContext): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const selection of expandSelections(operation.selections, context)) {
    if (selection.name === 'createIssue') {
      const input = inputObject(selection, context);
      const repo = repoById(parseGlobalId(input.repositoryId));
      if (repo === undefined) throw new Error('repository not found');
      const created = now();
      const number = repo.nextIssue;
      repo.nextIssue += 1;
      const issue: Issue = {
        id: number,
        number,
        title: stringField(input.title),
        body: stringField(input.body),
        state: 'open',
        labels: [],
        created_at: created,
        updated_at: created,
        comments: [],
      };
      repo.issues.push(issue);
      data[selection.alias] = resolveField({ __typename: 'CreateIssuePayload', issue: issueValue(repo, issue) }, selection, context, 'CreateIssuePayload');
      continue;
    }
    if (selection.name === 'closeIssue') {
      const input = inputObject(selection, context);
      const found = issueById(parseGlobalId(input.issueId));
      if (found === undefined) throw new Error('issue not found');
      found.issue.state = 'closed';
      found.issue.updated_at = now();
      invalidateIssueBuffer(found.repo, found.issue.number);
      data[selection.alias] = resolveField({ __typename: 'CloseIssuePayload', issue: issueValue(found.repo, found.issue) }, selection, context, 'CloseIssuePayload');
      continue;
    }
    if (selection.name === 'createPullRequest') {
      const input = inputObject(selection, context);
      const repo = repoById(parseGlobalId(input.repositoryId));
      if (repo === undefined) throw new Error('repository not found');
      const headName = stringField(input.headRefName);
      const baseName = stringField(input.baseRefName);
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
        title: stringField(input.title),
        body: stringField(input.body),
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
      data[selection.alias] = resolveField({ __typename: 'CreatePullRequestPayload', pullRequest: pullRequestValue(repo, pull) }, selection, context, 'CreatePullRequestPayload');
      continue;
    }
    if (selection.name === 'mergePullRequest') {
      const input = inputObject(selection, context);
      const found = pullById(parseGlobalId(input.pullRequestId));
      if (found === undefined) throw new Error('Pull Request is not mergeable');
      const { repo, pull } = found;
      if (pull.merged) throw new Error('Pull Request is not mergeable');
      const baseSha = branchTip(repo, pull.base.ref);
      const headSha = branchTip(repo, pull.head.ref);
      if (baseSha === undefined || headSha === undefined) throw new Error('Pull Request is not mergeable');
      const baseIsAncestor = isAncestor(repo, baseSha, headSha);
      const headIsAncestor = isAncestor(repo, headSha, baseSha);
      if (!baseIsAncestor && !headIsAncestor) throw new Error('Pull Request is not mergeable');
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
      data[selection.alias] = resolveField({ __typename: 'MergePullRequestPayload', pullRequest: pullRequestValue(repo, pull) }, selection, context, 'MergePullRequestPayload');
      continue;
    }
    if (selection.name === 'addComment') {
      const input = inputObject(selection, context);
      const found = issueById(parseGlobalId(input.subjectId));
      if (found === undefined) throw new Error('issue not found');
      const body = stringField(input.body);
      if (body.trim() === '') throw new Error('body must not be empty');
      const created = now();
      const comment: Comment = {
        id: found.repo.nextComment,
        body,
        user: owner,
        created_at: created,
        updated_at: created,
      };
      found.repo.nextComment += 1;
      found.issue.comments.push(comment);
      found.issue.updated_at = created;
      invalidateIssueBuffer(found.repo, found.issue.number);
      const edge = { node: commentValue(comment) };
      data[selection.alias] = resolveField({ __typename: 'AddCommentPayload', commentEdge: edge }, selection, context, 'AddCommentPayload');
      continue;
    }
    throw new Error(`Cannot query field "${selection.name}" on type "Mutation"`);
  }
  return data;
}

function sendUnauthorized(res: ServerResponse): void {
  const bytes = Buffer.from(JSON.stringify({ message: 'Requires authentication' }), 'utf8');
  res.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'x-github-request-id': nextRequestId(),
    'x-github-api-version': '2022-11-28',
  });
  res.end(bytes);
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req.headers.authorization)) {
    sendUnauthorized(res);
    return;
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
    length += bytes.length;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    sendErrors(res, ['invalid JSON body']);
    return;
  }
  const operations = Array.isArray(raw) ? raw : [raw];
  if (operations.length === 0) {
    sendErrors(res, ['missing query']);
    return;
  }
  const responses: Record<string, unknown>[] = [];
  for (const entry of operations) {
    const body = entry as { query?: string; variables?: Record<string, unknown> };
    if (typeof body?.query !== 'string' || body.query.trim() === '') {
      responses.push({ errors: [{ message: 'missing query' }] });
      continue;
    }
    let operation: Operation;
    try {
      operation = parseGraphQL(body.query);
    } catch (error) {
      responses.push({ errors: [{ message: error instanceof Error ? error.message : 'syntax error' }] });
      continue;
    }
    const variables = new Map<string, unknown>();
    if (body.variables !== null && typeof body.variables === 'object') {
      for (const [key, value] of Object.entries(body.variables)) variables.set(key, value);
    }
    const context: ResolverContext = { variables, fragments: operation.fragments };
    try {
      const data = operation.type === 'mutation'
        ? resolveMutation(operation, context)
        : resolveQuery(operation, context);
      responses.push({ data });
    } catch (error) {
      responses.push({ errors: [{ message: error instanceof Error ? error.message : 'internal error' }] });
    }
  }
  const payload = Array.isArray(raw) ? responses : responses[0];
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'x-github-request-id': nextRequestId(),
    'x-github-api-version': '2022-11-28',
  });
  res.end(bytes);
}
