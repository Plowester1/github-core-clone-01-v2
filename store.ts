import { createHash } from 'node:crypto';

export type FileEntry = { sha: string; bytes: Buffer };
export type Tree = Map<string, FileEntry>;
export type GitObject = { type: 'blob' | 'tree' | 'commit' | 'tag'; bytes: Buffer };
export type Issue = { id: number; number: number; title: string; body: string; state: 'open' | 'closed'; labels: { name: string; color: string; description?: string }[]; created_at: string; updated_at: string; comments: Comment[] };
export type Comment = { id: number; body: string; user: User; created_at: string; updated_at: string };
export type User = { login: string; id: number; name: string; email: string };
export type Pull = { number: number; title: string; body: string; state: 'open' | 'closed'; head: { ref: string; sha: string; label: string }; base: { ref: string; sha: string; label: string }; mergeBase: string; merged: boolean; mergeable: boolean; merged_at?: string; merge_commit_sha?: string; created_at: string; updated_at: string; user: User };
export type Repo = { id: number; name: string; owner: User; private: boolean; description: string; defaultBranch: string; created_at: string; updated_at: string; refs: Map<string, string>; trees: Map<string, Tree>; objects: Map<string, GitObject>; commits: Map<string, { tree: string; parents: string[]; message: string; author: User; date: string }>; issues: Map<number, Issue>; pulls: Map<number, Pull>; labels: Map<string, { name: string; color: string; description?: string }>; nextIssue: number; nextComment: number };

export const OWNER = 'adaiversen';
export const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
export const owner: User = { login: OWNER, id: 1000, name: 'Ada Iversen', email: 'adaiversen@example.invalid' };
const epoch = (() => { const value = process.env.MAKEFUN_TRIAL_NOW; const parsed = value ? Date.parse(value) : Number.NaN; return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1767225600; })();
let tick = 0;
export function isoFromSeconds(total: number): string {
  let days = Math.floor(total / 86400); const seconds = ((total % 86400) + 86400) % 86400;
  let year = 1970;
  while (days >= (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 366 : 365)) days -= year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 366 : 365, year += 1;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; let month = 0;
  while (days >= monthDays[month]!) days -= monthDays[month]!, month += 1;
  const pad = (n: number, width: number) => String(n).padStart(width, '0'); const hour = Math.floor(seconds / 3600); const minute = Math.floor((seconds % 3600) / 60); const second = seconds % 60;
  return `${year}-${pad(month + 1, 2)}-${pad(days + 1, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.000Z`;
}
export const now = (): string => isoFromSeconds(epoch + tick++);
export const nodeId = (kind: string, repo: Repo, number: number): string => Buffer.from(`github-core-clone-01:${kind}:${repo.owner.login}/${repo.name}:${number}`).toString('base64url');
export const sha1 = (type: string, bytes: Buffer): string => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');

function snapshot(repo: Repo, tree: Tree): string {
  // Git tree names are single path components; directories have their own objects.
  const build = (files: Tree): string => {
    const dirs = new Map<string, Tree>();
    const entries: { name: string; mode: string; sha: string }[] = [];
    for (const [path, file] of files) {
      const slash = path.indexOf('/');
      if (slash < 0) entries.push({ name: path, mode: '100644', sha: file.sha });
      else {
        const name = path.slice(0, slash);
        if (!dirs.has(name)) dirs.set(name, new Map());
        dirs.get(name)!.set(path.slice(slash + 1), file);
      }
    }
    for (const [name, children] of dirs) entries.push({ name, mode: '40000', sha: build(children) });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))));
    const bytes = Buffer.concat(entries.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')]));
    const sha = sha1('tree', bytes);
    repo.objects.set(sha, { type: 'tree', bytes });
    return sha;
  };
  return build(tree);
}
export function commit(repo: Repo, tree: Tree, message: string, parents: string[] = []): string {
  for (const file of tree.values()) repo.objects.set(file.sha, { type: 'blob', bytes: file.bytes });
  const treeSha = snapshot(repo, tree); const date = now(); const lines = [`tree ${treeSha}`, ...parents.map((p) => `parent ${p}`), `author ${owner.name} <${owner.email}> ${Math.floor(Date.parse(date) / 1000)} +0000`, `committer ${owner.name} <${owner.email}> ${Math.floor(Date.parse(date) / 1000)} +0000`, '', message.endsWith('\n') ? message : `${message}\n`];
  const bytes = Buffer.from(lines.join('\n')); const sha = sha1('commit', bytes); repo.objects.set(sha, { type: 'commit', bytes }); repo.commits.set(sha, { tree: treeSha, parents, message, author: owner, date }); return sha;
}
export function treeAt(repo: Repo, ref: string): Tree { const sha = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? ref; const c = repo.commits.get(sha); return new Map(c ? repo.trees.get(c.tree) : undefined); }
export function setTree(repo: Repo, ref: string, tree: Tree, message: string): string { const parent = repo.refs.get(ref); const sha = commit(repo, tree, message, parent ? [parent] : []); repo.refs.set(ref, sha); repo.trees.set(repo.commits.get(sha)!.tree, new Map(tree)); repo.updated_at = now(); return sha; }
export function makeRepo(name: string, input: Record<string, unknown> = {}): Repo { return { id: 5000 + repos.size, name, owner, private: input.private === true, description: typeof input.description === 'string' ? input.description : '', defaultBranch: typeof input.default_branch === 'string' && input.default_branch ? input.default_branch : 'main', created_at: now(), updated_at: now(), refs: new Map(), trees: new Map(), objects: new Map(), commits: new Map(), issues: new Map(), pulls: new Map(), labels: new Map(), nextIssue: 1, nextComment: 1 }; }
export const repos = new Map<string, Repo>();
export const repoKey = (o: string, r: string): string => `${o}/${r}`;
export function getRepo(o: string, r: string): Repo | undefined { return o === OWNER ? repos.get(repoKey(o, r)) : undefined; }
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean { let current: string | undefined = descendant; const seen = new Set<string>(); while (current && !seen.has(current)) { if (current === ancestor) return true; seen.add(current); current = repo.commits.get(current)?.parents[0]; } return false; }
export function mergeBaseOf(repo: Repo, head: string, base: string): string { const seen = new Set<string>(); const queue = [head]; while (queue.length) { const oid = queue.pop()!; if (seen.has(oid)) continue; seen.add(oid); const parents = repo.commits.get(oid)?.parents ?? []; for (const p of parents) queue.push(p); } let current: string | undefined = base; const visited = new Set<string>(); while (current && !visited.has(current)) { if (seen.has(current)) return current; visited.add(current); current = repo.commits.get(current)?.parents[0]; } return base; }
