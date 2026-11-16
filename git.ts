import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getRepo, isoFromSeconds, sha1, type GitObject, type Repo, type Tree } from './store.ts';

const ZERO = '0'.repeat(40);
const MAX = 65520;
const agent = 'github-core-clone-01-v2';
const pkt = (data: Buffer | string): Buffer => { const b = Buffer.isBuffer(data) ? data : Buffer.from(data); if (b.length + 4 > MAX) throw new Error('pkt-line too large'); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); };
const flush = () => Buffer.from('0000');
const delim = () => Buffer.from('0001');
const encode = (items: (Buffer | string | 'flush' | 'delim')[]) => Buffer.concat(items.map((x) => x === 'flush' ? flush() : x === 'delim' ? delim() : pkt(x)));
const readBody = async (req: IncomingMessage): Promise<Buffer> => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return Buffer.concat(chunks); };
const contentType = (res: ServerResponse, type: string, body: Buffer) => { res.writeHead(200, { 'content-type': type, 'content-length': body.length }); res.end(body); };
const notFound = (res: ServerResponse) => { res.writeHead(404, { 'content-type': 'text/plain', 'content-length': 9 }); res.end('Not Found'); };

function treeEntries(bytes: Buffer): { mode: string; name: string; oid: string }[] {
  const entries = []; let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(32, at), nul = bytes.indexOf(0, space + 1);
    if (space < at || nul < space || nul + 21 > bytes.length) throw new Error('Malformed tree');
    entries.push({ mode: bytes.toString('ascii', at, space), name: bytes.toString('utf8', space + 1, nul), oid: bytes.subarray(nul + 1, nul + 21).toString('hex') });
    at = nul + 21;
  }
  return entries;
}
function isAncestor(repo: Repo, old: string, tip: string): boolean {
  const queue = [tip], seen = new Set<string>();
  while (queue.length) { const oid = queue.pop()!; if (oid === old) return true; if (seen.has(oid)) continue; seen.add(oid); queue.push(...(commitView(repo, oid)?.parents ?? [])); }
  return false;
}

function refs(repo: Repo): [string, string][] { return [...repo.refs].sort(([a], [b]) => a.localeCompare(b)); }
function commitView(repo: Repo, oid: string): { tree: string; parents: string[]; author: string; committer: string; message: string } | null { const o = repo.objects.get(oid); if (!o || o.type !== 'commit') return null; const text = o.bytes.toString(); const split = text.indexOf('\n\n'); const headers = text.slice(0, split < 0 ? text.length : split).split('\n'); const out = { tree: '', parents: [] as string[], author: '', committer: '', message: split < 0 ? '' : text.slice(split + 2) }; for (const line of headers) { const i = line.indexOf(' '); const k = i < 0 ? line : line.slice(0, i); const v = i < 0 ? '' : line.slice(i + 1); if (k === 'tree') out.tree = v; else if (k === 'parent') out.parents.push(v); else if (k === 'author') out.author = v; else if (k === 'committer') out.committer = v; } return out.tree ? out : null; }
function tagTarget(repo: Repo, oid: string): string | undefined { const o = repo.objects.get(oid); if (!o || o.type !== 'tag') return; const m = /^object ([0-9a-f]{40})/m.exec(o.bytes.toString()); return m?.[1]; }
function treeObjectFiles(repo: Repo, oid: string, prefix: string, out: Tree): void { const object = repo.objects.get(oid); if (!object || object.type !== 'tree') return; let at = 0; while (at < object.bytes.length) { const space = object.bytes.indexOf(0x20, at); const nul = object.bytes.indexOf(0, space + 1); const mode = object.bytes.subarray(at, space).toString(); const name = object.bytes.subarray(space + 1, nul).toString(); const child = object.bytes.subarray(nul + 1, nul + 21).toString('hex'); if (mode === '40000') treeObjectFiles(repo, child, `${prefix}${name}/`, out); else { const blob = repo.objects.get(child); if (blob?.type === 'blob') out.set(`${prefix}${name}`, { sha: child, bytes: blob.bytes }); } at = nul + 21; } }
function indexCommit(repo: Repo, oid: string): void { const c = commitView(repo, oid); if (!c) return; const tree = new Map<string, any>(); treeObjectFiles(repo, c.tree, '', tree); repo.commits.set(oid, { tree: c.tree, parents: c.parents, message: c.message.replace(/\n$/, ''), author: { login: repo.owner.login, id: repo.owner.id, name: c.author.replace(/ <.*$/, ''), email: /<([^>]+)>/.exec(c.author)?.[1] ?? repo.owner.email }, date: isoFromSeconds(Number(c.author.split(' ').at(-2)) || 0) }); repo.trees.set(c.tree, tree); }

function parsePack(pack: Buffer, existing: Map<string, GitObject>): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString() !== 'PACK') throw new Error('bad pack');
  const trailer = pack.subarray(-20); const sum = createHash('sha1').update(pack.subarray(0, -20)).digest(); if (!sum.equals(trailer)) throw new Error('pack checksum');
  if (![2, 3].includes(pack.readUInt32BE(4))) throw new Error('pack version');
  const count = pack.readUInt32BE(8); let at = 12; const raw: { offset: number; type: number; data: Buffer; baseOffset?: number; baseOid?: string }[] = []; const byOffset = new Map<number, any>();
  const size = (start: number) => { const first = pack[start]; let b = first, n = b & 15, shift = 4; start++; while (b & 128) { if (start >= pack.length - 20 || shift > 49) throw new Error('size overflow'); b = pack[start++]!; n += (b & 127) * 2 ** shift; shift += 7; } return { n, at: start, first }; };
  for (let i = 0; i < count; i++) { const offset = at; const h = size(at); at = h.at; const type = (h.first >> 4) & 7; const e: any = { offset, type, data: Buffer.alloc(0) }; if (type === 6) { let b = pack[at++]!, value = b & 127; while (b & 128) { b = pack[at++]!; value = (value + 1) * 128 + (b & 127); } e.baseOffset = offset - value; } else if (type === 7) { e.baseOid = pack.subarray(at, at + 20).toString('hex'); at += 20; } const inflated = inflateSync(pack.subarray(at, -20), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }; e.data = inflated.buffer; at += inflated.engine.bytesWritten; raw.push(e); byOffset.set(offset, e); }
  const code: Record<number, GitObject['type']> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' }; const resolved = new Map<number, GitObject & { oid: string }>(); const byOid = new Map<string, GitObject & { oid: string }>(); const out = new Map<string, GitObject>();
  const delta = (base: Buffer, d: Buffer) => { let p = 0; const varint = () => { let n = 0, s = 0, b; do { b = d[p++]!; n += (b & 127) * 2 ** s; s += 7; } while (b & 128); return n; }; const source = varint(); const target = varint(); if (source !== base.length) throw new Error('delta base size'); const result = Buffer.alloc(target); let w = 0; while (p < d.length) { const op = d[p++]!; if (op & 128) { let off = 0, len = 0; for (let i = 0; i < 4; i++) if (op & (1 << i)) off += d[p++]! * 2 ** (i * 8); for (let i = 0; i < 3; i++) if (op & (1 << (i + 4))) len += d[p++]! * 2 ** (i * 8); if (!len) len = 65536; base.copy(result, w, off, off + len); w += len; } else { d.copy(result, w, p, p + op); p += op; w += op; } } if (w !== target) throw new Error('delta result size'); return result; };
  const resolving = new Set<number>();
  const resolve = (e: any): GitObject & { oid: string } => {
    if (!e || resolving.has(e.offset)) throw new Error('invalid delta base');
    if (resolved.has(e.offset)) return resolved.get(e.offset)!;
    resolving.add(e.offset);
    let type: GitObject['type']; let data: Buffer;
    if (e.type === 6 || e.type === 7) {
      const base = e.type === 6 ? resolve(byOffset.get(e.baseOffset)) : byOid.get(e.baseOid) ?? existing.get(e.baseOid);
      if (!base) { resolving.delete(e.offset); throw new Error('missing ref delta base'); }
      type = base.type; data = delta(base.bytes, e.data);
    } else { type = code[e.type]; if (!type) throw new Error('bad object type'); data = e.data; }
    const oid = sha1(type, data); const value = { type, bytes: data, oid };
    resolved.set(e.offset, value); byOid.set(oid, value); out.set(oid, { type, bytes: data }); resolving.delete(e.offset); return value;
  };
  if (at !== pack.length - 20) throw new Error('trailing pack bytes');
  for (const e of raw) if (e.type >= 1 && e.type <= 4) resolve(e);
  let pending = raw.filter((e) => !resolved.has(e.offset));
  while (pending.length) {
    const before = pending.length;
    for (const e of pending) { try { resolve(e); } catch (err) { if (!(err instanceof Error) || err.message !== 'missing ref delta base') throw err; } }
    pending = pending.filter((e) => !resolved.has(e.offset));
    if (pending.length === before) throw new Error('unresolved deltas');
  }
  return out;
}

type Selection = { ids: Set<string>; shallow: Set<string> };
function reachable(repo: Repo, roots: string[], depth = Infinity, stops = new Set<string>()): Selection {
  const ids = new Set<string>(), shallow = new Set<string>();
  const queue: [string, number][] = roots.map((oid) => [oid, 1]);
  // Breadth-first ensures shared ancestors are visited at their shortest distance from a want.
  for (let i = 0; i < queue.length; i++) {
    const [oid, generation] = queue[i]; if (ids.has(oid) || oid === ZERO) continue;
    const object = repo.objects.get(oid); if (!object) continue; ids.add(oid);
    if (object.type === 'commit') {
      const c = commitView(repo, oid)!; queue.push([c.tree, generation]);
      if (generation >= depth || stops.has(oid)) { if (c.parents.length) shallow.add(oid); }
      else for (const parent of c.parents) queue.push([parent, generation + 1]);
    } else if (object.type === 'tree') {
      for (const e of treeEntries(object.bytes)) if (e.mode !== '160000') queue.push([e.oid, generation]);
    } else if (object.type === 'tag') { const target = tagTarget(repo, oid); if (target) queue.push([target, generation]); }
  }
  return { ids, shallow };
}
type CachedPack = { pack: Buffer; framed: Buffer; shallow: string[]; unshallow: string[] };
const cache = new Map<Repo, { refs: string; packs: Map<string, CachedPack> }>();
function invalidate(repo: Repo) { cache.delete(repo); }
function sideband(bytes: Buffer): Buffer {
  const frames: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += MAX - 5) frames.push(pkt(Buffer.concat([Buffer.from([1]), bytes.subarray(at, at + MAX - 5)])));
  frames.push(flush()); return Buffer.concat(frames);
}
function packFor(repo: Repo, wants: string[], depth: number | undefined, haves: string[], boundaries: string[]): CachedPack {
  const signature = [...repo.refs].map(([r, oid]) => `${r}:${oid}`).join('|');
  let entry = cache.get(repo);
  if (!entry || entry.refs !== signature) { entry = { refs: signature, packs: new Map() }; cache.set(repo, entry); }
  const key = JSON.stringify([[...wants].sort(), depth ?? 0, [...haves].sort(), [...boundaries].sort()]); const cached = entry.packs.get(key); if (cached) return cached;
  const held = reachable(repo, haves, Infinity, new Set(boundaries)).ids;
  const selection = reachable(repo, wants, depth);
  const ids = [...selection.ids].filter((oid) => !held.has(oid)).sort();
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(ids.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of ids) {
    const object = repo.objects.get(oid)!; let n = object.bytes.length; const bytes: number[] = [];
    let byte = ({ commit: 1, tree: 2, blob: 3, tag: 4 }[object.type] << 4) | (n & 15); n = Math.floor(n / 16);
    while (n) { bytes.push(byte | 128); byte = n & 127; n = Math.floor(n / 128); } bytes.push(byte);
    parts.push(Buffer.from(bytes), deflateSync(object.bytes, { level: 1 }));
  }
  const body = Buffer.concat(parts); const pack = Buffer.concat([body, createHash('sha1').update(body).digest()]);
  const value = { pack, framed: sideband(pack), shallow: [...selection.shallow], unshallow: boundaries.filter((oid) => selection.ids.has(oid) && !selection.shallow.has(oid)) };
  if (pack.length < 8 * 1024 * 1024) entry.packs.set(key, value);
  if (entry.packs.size > 4) entry.packs.delete(entry.packs.keys().next().value!);
  if (cache.size > 4) cache.delete(cache.keys().next().value!);
  return value;
}

function advertise(repo: Repo, service: string, v2: boolean): Buffer { if (v2) return encode(['version 2\n', 'ls-refs=unborn\n', 'fetch=shallow wait-for-done\n', 'server-option\n', 'object-format=sha1\n', `agent=${agent}\n`, 'flush']); const caps = service === 'git-receive-pack' ? 'report-status side-band-64k delete-refs ofs-delta agent=' + agent : 'side-band-64k thin-pack ofs-delta agent=' + agent; const lines: (string | 'flush')[] = [`# service=${service}\n`, 'flush']; const all = refs(repo); const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`); if (head) lines.push(`${head} HEAD\0symref=HEAD:refs/heads/${repo.defaultBranch} ${caps}\n`); if (all.length) for (const [ref, oid] of all) lines.push(`${oid} ${ref}\n`); else lines.push(`${ZERO} capabilities^{}\0${caps}\n`); lines.push('flush'); return encode(lines); }

function lsRefs(repo: Repo, lines: string[]): Buffer {
  const prefixes = lines.filter((x) => x.startsWith('ref-prefix ')).map((x) => x.slice(11));
  const allow = (name: string) => !prefixes.length || prefixes.some((p) => name.startsWith(p));
  const out: string[] = [], headRef = `refs/heads/${repo.defaultBranch}`, head = repo.refs.get(headRef);
  if (allow('HEAD')) {
    if (head) out.push(`${head} HEAD${lines.includes('symrefs') ? ` symref-target:${headRef}` : ''}\n`);
    else if (lines.includes('unborn')) out.push(`unborn HEAD symref-target:${headRef}\n`);
  }
  for (const [ref, oid] of refs(repo)) if (allow(ref)) {
    let target = oid; const seen = new Set<string>();
    while (!seen.has(target)) { seen.add(target); const next = tagTarget(repo, target); if (!next) break; target = next; }
    out.push(`${oid} ${ref}${lines.includes('peel') && target !== oid ? ` peeled:${target}` : ''}\n`);
  }
  return encode([...out, 'flush']);
}

function requestPackets(body: Buffer): { packets: { payload: Buffer }[]; rest: Buffer } {
  const packets: { payload: Buffer }[] = []; let at = 0;
  while (at + 4 <= body.length) {
    const header = body.toString('ascii', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('bad pkt header');
    const n = Number.parseInt(header, 16); at += 4;
    if (n === 0) return { packets, rest: body.subarray(at) };
    if (n === 1 || n === 2) continue;
    if (n < 4 || n > MAX || at + n - 4 > body.length) throw new Error('bad pkt length');
    packets.push({ payload: body.subarray(at, at + n - 4) }); at += n - 4;
  }
  if (at !== body.length) throw new Error('truncated packet');
  return { packets, rest: Buffer.alloc(0) };
}
function report(repo: Repo, commands: { old: string; next: string; ref: string }[], objects: Map<string, GitObject>): Buffer {
  for (const [oid, object] of objects) repo.objects.set(oid, object);
  for (const oid of objects.keys()) if (repo.objects.get(oid)?.type === 'commit') indexCommit(repo, oid);
  const lines: Buffer[] = [pkt('unpack ok\n')];
  for (const { old, next, ref } of commands) {
    const current = repo.refs.get(ref) ?? ZERO;
    const okay = current === old && (next === ZERO || (repo.objects.has(next) && (old === ZERO || old === next || (ref.startsWith('refs/heads/') && isAncestor(repo, old, next)))));
    if (okay) { if (next === ZERO) repo.refs.delete(ref); else repo.refs.set(ref, next); invalidate(repo); lines.push(pkt(`ok ${ref}\n`)); }
    else lines.push(pkt(`ng ${ref} non-fast-forward\n`));
  }
  return Buffer.concat(lines);
}

export async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, owner: string, name: string): Promise<void> {
  const auth = req.headers.authorization; const valid = process.env.MAKEFUN_SHOP_TOKEN ? auth === `Bearer ${process.env.MAKEFUN_SHOP_TOKEN}` || auth === `token ${process.env.MAKEFUN_SHOP_TOKEN}` : false; if (!valid) { res.writeHead(401); res.end(); return; }
  const repo = getRepo(owner, name); if (!repo) { notFound(res); return; }
  try {
    if (url.pathname.endsWith('/info/refs')) { const service = url.searchParams.get('service') ?? ''; if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { notFound(res); return; } const v2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2'; contentType(res, `application/x-${service}-advertisement`, advertise(repo, service, v2)); return; }
    const body = await readBody(req);
    if (url.pathname.endsWith('/git-receive-pack')) {
      const parsed = requestPackets(body);
      const commands = parsed.packets.map((p) => {
        const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s\0]+)(?:\0|\n|$)/.exec(p.payload.toString());
        if (!match) throw new Error('invalid push command');
        return { old: match[1], next: match[2], ref: match[3] };
      });
      const objects = parsed.rest.length ? parsePack(parsed.rest, repo.objects) : new Map<string, GitObject>();
      const inner = Buffer.concat([report(repo, commands, objects), flush()]);
      const band = parsed.packets[0]?.payload.toString().includes('side-band-64k');
      contentType(res, 'application/x-git-receive-pack-result', band ? sideband(inner) : inner); return;
    }
    if (url.pathname.endsWith('/git-upload-pack')) {
      const isV2 = req.headers['git-protocol'] === 'version=2';
      const packets = []; let rest = body;
      do { const parsed = requestPackets(rest); packets.push(...parsed.packets); rest = parsed.rest; } while (rest.length);
      const lines = packets.map((p) => p.payload.toString().replace(/\n$/, ''));
      if (isV2 && lines.includes('command=ls-refs')) { contentType(res, 'application/x-git-upload-pack-result', lsRefs(repo, lines)); return; }
      const values = (key: string) => [...new Set(lines.filter((l) => l.startsWith(key + ' ')).map((l) => l.split(' ')[1]))];
      const wants = values('want'), haves = values('have'), boundaries = values('shallow');
      const depth = Number(values('deepen')[0]) || undefined;
      const pack = packFor(repo, wants, depth, haves, boundaries);
      const shallow = [...pack.shallow.map((oid) => pkt(`shallow ${oid}\n`)), ...pack.unshallow.map((oid) => pkt(`unshallow ${oid}\n`))];
      const prefix: Buffer[] = [];
      if (isV2) {
        // A done request goes straight to shallow-info/packfile, as native Git requires.
        if (!lines.includes('done')) {
          const common = haves.filter((oid) => repo.objects.has(oid));
          prefix.push(pkt('acknowledgments\n'), ...(!common.length ? [pkt('NAK\n')] : common.map((oid) => pkt(`ACK ${oid}\n`))));
          if (!common.length) { contentType(res, 'application/x-git-upload-pack-result', Buffer.concat([...prefix, flush()])); return; }
          prefix.push(pkt('ready\n'), delim());
        }
        if (shallow.length) prefix.push(pkt('shallow-info\n'), ...shallow, delim());
        prefix.push(pkt('packfile\n'));
      } else {
        if (depth) prefix.push(...shallow, flush());
        prefix.push(pkt('NAK\n'));
      }
      contentType(res, 'application/x-git-upload-pack-result', Buffer.concat([...prefix, pack.framed])); return;
    }
    notFound(res);
  } catch { if (!res.headersSent) { res.writeHead(400, { 'content-type': 'text/plain', 'content-length': 11 }); res.end('Bad request'); } else res.destroy(); }
}
