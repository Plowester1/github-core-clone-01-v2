import { createHash } from 'node:crypto';

export type ObjectKind = 'blob' | 'tree' | 'commit' | 'tag';
export type IssueState = 'open' | 'closed';

export interface User {
  login: string;
  id: number;
  name: string;
  email: string;
}

export interface Identity {
  name: string;
  email: string;
}

export interface GitObject {
  type: ObjectKind;
  bytes: Buffer;
}

export interface FileEntry {
  sha: string;
  bytes: Buffer;
}

export type FileTree = Map<string, FileEntry>;

export interface CommitIndex {
  tree: string;
  parents: string[];
  message: string;
  author: Identity;
  date: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: Label[];
  created_at: string;
  updated_at: string;
  comments: Comment[];
}

export interface PullBranch {
  ref: string;
  sha: string;
  label: string;
}

export interface Pull {
  id: string;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  head: PullBranch;
  base: PullBranch;
  mergeBase: string;
  merged: boolean;
  mergeable: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  created_at: string;
  updated_at: string;
  user: User;
}

export interface Repo {
  id: number;
  name: string;
  owner: User;
  private: boolean;
  description: string;
  defaultBranch: string;
  created_at: string;
  updated_at: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  trees: Map<string, FileTree>;
  commits: Map<string, CommitIndex>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  nextLabel: number;
  issueBuffers: Map<number, Buffer>;
  pullBuffers: Map<number, Buffer>;
  repoBuffer: Buffer | null;
  generation: number;
}

export const OWNER_LOGIN = 'adaiversen';
export const owner: User = {
  login: OWNER_LOGIN,
  id: 1000,
  name: 'Ada Iversen',
  email: 'adaiversen@example.invalid',
};

const trialEpoch = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1767225600;
})();

let clockTick = 0;
let requestCounter = 0;
let repoCounter = 0;

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function isoFromSeconds(total: number): string {
  let days = Math.floor(total / 86400);
  let seconds = total - days * 86400;
  let year = 1970;
  while (days >= (leapYear(year) ? 366 : 365)) {
    days -= leapYear(year) ? 366 : 365;
    year += 1;
  }
  const lengths = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let month = 0;
  while (days >= lengths[month]) {
    days -= lengths[month];
    month += 1;
  }
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  const hour = Math.floor(seconds / 3600);
  const minute = Math.floor((seconds - hour * 3600) / 60);
  const second = seconds - hour * 3600 - minute * 60;
  return `${year}-${pad(month + 1, 2)}-${pad(days + 1, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.000Z`;
}

export function now(): string {
  const value = isoFromSeconds(trialEpoch + clockTick);
  clockTick += 1;
  return value;
}

export function nextRequestId(): string {
  requestCounter += 1;
  return `rebuild-${requestCounter}`;
}

export function authorized(header: string | undefined): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '' || header === undefined) return false;
  return header === `Bearer ${token}` || header === `token ${token}`;
}

export function nodeId(kind: 'issue' | 'pull' | 'comment', repo: Repo, number: number): string {
  return Buffer.from(`github-core-clone-01:${kind}:${repo.owner.login}/${repo.name}:${number}`).toString('base64url');
}

export function repoNodeId(repo: Repo): string {
  return Buffer.from(`github-core-clone-01:repo:${repo.owner.login}/${repo.name}`).toString('base64url');
}

export function hashObject(type: ObjectKind, bytes: Buffer): string {
  return createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
}

export const repos = new Map<string, Repo>();

export function repoKey(ownerName: string, repoName: string): string {
  return `${ownerName}/${repoName}`;
}

export function getRepo(ownerName: string, repoName: string): Repo | undefined {
  if (ownerName !== OWNER_LOGIN) return undefined;
  return repos.get(repoKey(ownerName, repoName));
}

export function createRepo(name: string, input: Record<string, unknown> = {}): Repo {
  repoCounter += 1;
  const created = now();
  const repo: Repo = {
    id: 5000 + repoCounter,
    name,
    owner,
    private: input.private === true,
    description: typeof input.description === 'string' ? input.description : '',
    defaultBranch: typeof input.default_branch === 'string' && input.default_branch !== '' ? input.default_branch : 'main',
    created_at: created,
    updated_at: created,
    refs: new Map(),
    objects: new Map(),
    trees: new Map(),
    commits: new Map(),
    issues: [],
    pulls: [],
    labels: new Map(),
    nextIssue: 1,
    nextPull: 1,
    nextComment: 1,
    nextLabel: 1,
    issueBuffers: new Map(),
    pullBuffers: new Map(),
    repoBuffer: null,
    generation: 0,
  };
  repos.set(repoKey(owner.login, name), repo);
  return repo;
}

export function deleteRepo(repo: Repo): void {
  repos.delete(repoKey(repo.owner.login, repo.name));
}

export function issueAt(repo: Repo, number: number): Issue | undefined {
  if (!Number.isInteger(number) || number < 1) return undefined;
  return repo.issues[number - 1];
}

export function pullAt(repo: Repo, number: number): Pull | undefined {
  if (!Number.isInteger(number) || number < 1) return undefined;
  return repo.pulls[number - 1];
}

function compareTreeNames(leftName: string, leftMode: string, rightName: string, rightMode: string): number {
  const left = leftMode === '40000' ? `${leftName}/` : leftName;
  const right = rightMode === '40000' ? `${rightName}/` : rightName;
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function writeTreeObject(repo: Repo, files: FileTree): string {
  const directories = new Map<string, FileTree>();
  const entries: { name: string; mode: string; sha: string }[] = [];
  for (const [path, file] of files) {
    const slash = path.indexOf('/');
    if (slash < 0) {
      entries.push({ name: path, mode: '100644', sha: file.sha });
      continue;
    }
    const directory = path.slice(0, slash);
    let child = directories.get(directory);
    if (child === undefined) {
      child = new Map();
      directories.set(directory, child);
    }
    child.set(path.slice(slash + 1), file);
  }
  for (const [name, child] of directories) {
    entries.push({ name, mode: '40000', sha: writeTreeObject(repo, child) });
  }
  entries.sort((left, right) => compareTreeNames(left.name, left.mode, right.name, right.mode));
  let length = 0;
  for (const entry of entries) length += Buffer.byteLength(entry.mode) + 1 + Buffer.byteLength(entry.name) + 1 + 20;
  const bytes = Buffer.allocUnsafe(length);
  let at = 0;
  for (const entry of entries) {
    at += bytes.write(entry.mode, at, 'ascii');
    bytes[at] = 0x20;
    at += 1;
    at += bytes.write(entry.name, at, 'utf8');
    bytes[at] = 0;
    at += 1;
    Buffer.from(entry.sha, 'hex').copy(bytes, at);
    at += 20;
  }
  const sha = hashObject('tree', bytes);
  repo.objects.set(sha, { type: 'tree', bytes });
  return sha;
}

export function commitFiles(repo: Repo, files: FileTree, message: string, parents: string[] = []): string {
  for (const file of files.values()) repo.objects.set(file.sha, { type: 'blob', bytes: file.bytes });
  const treeSha = writeTreeObject(repo, files);
  const date = now();
  const timestamp = trialEpoch + clockTick - 1;
  const header = [
    `tree ${treeSha}`,
    ...parents.map((parent) => `parent ${parent}`),
    `author ${owner.name} <${owner.email}> ${timestamp} +0000`,
    `committer ${owner.name} <${owner.email}> ${timestamp} +0000`,
  ];
  const text = message.endsWith('\n') ? message : `${message}\n`;
  const bytes = Buffer.from(`${header.join('\n')}\n\n${text}`, 'utf8');
  const sha = hashObject('commit', bytes);
  repo.objects.set(sha, { type: 'commit', bytes });
  repo.commits.set(sha, {
    tree: treeSha,
    parents: [...parents],
    message: text.endsWith('\n') ? text.slice(0, -1) : text,
    author: { name: owner.name, email: owner.email },
    date,
  });
  repo.trees.set(treeSha, new Map(files));
  return sha;
}

export function setTree(repo: Repo, ref: string, files: FileTree, message: string): string {
  const parent = repo.refs.get(ref);
  const sha = commitFiles(repo, files, message, parent === undefined ? [] : [parent]);
  repo.refs.set(ref, sha);
  repo.updated_at = now();
  repo.generation += 1;
  return sha;
}

export function resolveCommit(repo: Repo, value: string): string | undefined {
  if (repo.refs.has(value)) return repo.refs.get(value);
  if (repo.refs.has(`refs/heads/${value}`)) return repo.refs.get(`refs/heads/${value}`);
  if (repo.commits.has(value)) return value;
  return undefined;
}

export function treeAt(repo: Repo, value: string): FileTree {
  const sha = resolveCommit(repo, value);
  if (sha === undefined) return new Map();
  const commit = repo.commits.get(sha);
  if (commit === undefined) return new Map();
  return repo.trees.get(commit.tree) ?? new Map();
}

export function parseTreeEntries(bytes: Buffer): { mode: string; name: string; sha: string }[] {
  const entries: { mode: string; name: string; sha: string }[] = [];
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(0x20, at);
    const nul = bytes.indexOf(0, space + 1);
    if (space < at || nul < space || nul + 21 > bytes.length) throw new Error('malformed tree object');
    entries.push({
      mode: bytes.toString('ascii', at, space),
      name: bytes.toString('utf8', space + 1, nul),
      sha: bytes.subarray(nul + 1, nul + 21).toString('hex'),
    });
    at = nul + 21;
  }
  return entries;
}

export function flattenTree(repo: Repo, treeSha: string, prefix = ''): FileTree {
  const result: FileTree = new Map();
  const object = repo.objects.get(treeSha);
  if (object === undefined || object.type !== 'tree') return result;
  for (const entry of parseTreeEntries(object.bytes)) {
    if (entry.mode === '160000') continue;
    const path = `${prefix}${entry.name}`;
    if (entry.mode === '40000') {
      for (const [childPath, file] of flattenTree(repo, entry.sha, `${path}/`)) result.set(childPath, file);
      continue;
    }
    const blob = repo.objects.get(entry.sha);
    if (blob?.type === 'blob') result.set(path, { sha: entry.sha, bytes: blob.bytes });
  }
  return result;
}

function identityFromHeader(header: string, fallback: Identity): Identity {
  const open = header.indexOf('<');
  const close = header.indexOf('>', open + 1);
  const name = open < 0 ? header.slice(0, header.indexOf(' ')) : header.slice(0, open).trimEnd();
  const email = open >= 0 && close > open ? header.slice(open + 1, close) : fallback.email;
  return { name: name === '' ? fallback.name : name, email };
}

export function parseCommitObject(bytes: Buffer): CommitIndex {
  const separator = bytes.indexOf('\n\n');
  const headerText = bytes.toString('utf8', 0, separator < 0 ? bytes.length : separator);
  const message = separator < 0 ? '' : bytes.toString('utf8', separator + 2).replace(/\n$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = { name: owner.name, email: owner.email };
  let date = isoFromSeconds(trialEpoch);
  for (const line of headerText.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') {
      author = identityFromHeader(value, author);
      const parts = value.split(' ');
      const timestamp = Number(parts[parts.length - 2]);
      if (Number.isFinite(timestamp)) date = isoFromSeconds(timestamp);
    }
  }
  if (tree === '') throw new Error('commit object has no tree');
  return { tree, parents, message, author, date };
}

export function indexCommit(repo: Repo, oid: string): boolean {
  if (repo.commits.has(oid)) return false;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return false;
  const commit = parseCommitObject(object.bytes);
  repo.commits.set(oid, commit);
  repo.trees.set(commit.tree, flattenTree(repo, commit.tree));
  return true;
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const visited = new Set<string>();
  const queue: string[] = [descendant];
  for (let at = 0; at < queue.length; at += 1) {
    const oid = queue[at];
    if (oid === ancestor) return true;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const commit = repo.commits.get(oid);
    if (commit === undefined) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return false;
}

export function mergeBaseOf(repo: Repo, head: string, base: string): string {
  const baseAncestors = new Set<string>();
  const baseQueue: string[] = [base];
  for (let at = 0; at < baseQueue.length; at += 1) {
    const oid = baseQueue[at];
    if (baseAncestors.has(oid)) continue;
    baseAncestors.add(oid);
    const commit = repo.commits.get(oid);
    if (commit === undefined) continue;
    for (const parent of commit.parents) baseQueue.push(parent);
  }
  const visited = new Set<string>();
  const headQueue: string[] = [head];
  for (let at = 0; at < headQueue.length; at += 1) {
    const oid = headQueue[at];
    if (visited.has(oid)) continue;
    visited.add(oid);
    if (baseAncestors.has(oid)) return oid;
    const commit = repo.commits.get(oid);
    if (commit === undefined) continue;
    for (const parent of commit.parents) headQueue.push(parent);
  }
  return base;
}
