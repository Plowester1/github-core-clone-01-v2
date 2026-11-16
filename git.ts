import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  authorized,
  getRepo,
  hashObject,
  indexCommit,
  isAncestor,
  parseCommitObject,
  parseTreeEntries,
  type GitObject,
  type Repo,
} from './store.ts';

const MAX_PACKET = 65520;
const ZERO_OID = '0'.repeat(40);
const AGENT = 'github-core-clone-01-v2-rebuild';

export function pktLineEncode(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const header = Buffer.allocUnsafe(4);
  header.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, body]);
}

export function pktLineDecode(body: Buffer): { payload: Buffer; flush: boolean }[] {
  const packets: { payload: Buffer; flush: boolean }[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const size = Number.parseInt(body.toString('ascii', at, at + 4), 16);
    if (size === 0) {
      packets.push({ payload: Buffer.alloc(0), flush: true });
      at += 4;
      break;
    }
    if (size < 4 || at + size > body.length) throw new Error('malformed pkt-line');
    packets.push({ payload: body.subarray(at + 4, at + size), flush: false });
    at += size;
  }
  return packets;
}

function flushPkt(): Buffer {
  return Buffer.from('0000', 'ascii');
}

interface RawPackEntry {
  offset: number;
  kind: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

interface ResolvedObject {
  type: GitObject['type'];
  bytes: Buffer;
}

function readPackSize(buffer: Buffer, at: number): { size: number; kind: number; next: number } {
  let byte = buffer[at];
  const kind = (byte >> 4) & 7;
  let size = byte & 15;
  let shift = 4;
  let cursor = at + 1;
  while ((byte & 128) !== 0) {
    byte = buffer[cursor];
    size += (byte & 127) * 2 ** shift;
    shift += 7;
    cursor += 1;
  }
  return { size, kind, next: cursor };
}

function readOfsDistance(buffer: Buffer, at: number): { distance: number; next: number } {
  let byte = buffer[at];
  let distance = byte & 127;
  let cursor = at + 1;
  while ((byte & 128) !== 0) {
    byte = buffer[cursor];
    distance = ((distance + 1) << 7) | (byte & 127);
    cursor += 1;
  }
  return { distance, next: cursor };
}

function inflateAt(buffer: Buffer, at: number): { bytes: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(at), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { bytes: result.buffer, next: at + result.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at];
      at += 1;
      value += (byte & 127) * 2 ** shift;
      shift += 7;
      if ((byte & 128) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const output = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if ((op & 128) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          copyOffset += delta[at] * 2 ** (bit * 8);
          at += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (1 << (4 + bit))) !== 0) {
          copySize += delta[at] * 2 ** (bit * 8);
          at += 1;
        }
      }
      if (copySize === 0) copySize = 65536;
      base.copy(output, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(output, written, at, at + op);
      at += op;
      written += op;
    } else {
      throw new Error('invalid delta opcode');
    }
  }
  if (written !== targetSize) throw new Error('delta output size mismatch');
  return output;
}

function parsePack(buffer: Buffer, repo: Repo): Map<string, GitObject> {
  if (buffer.length < 32 || buffer.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack header');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = buffer.readUInt32BE(8);
  const trailerAt = buffer.length - 20;
  const checksum = createHash('sha1').update(buffer.subarray(0, trailerAt)).digest('hex');
  if (checksum !== buffer.toString('hex', trailerAt)) throw new Error('pack checksum mismatch');
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let at = 12;
  for (let index = 0; index < count; index += 1) {
    const offset = at;
    const header = readPackSize(buffer, at);
    at = header.next;
    const entry: RawPackEntry = { offset, kind: header.kind, data: Buffer.alloc(0) };
    if (header.kind === 6) {
      const ofs = readOfsDistance(buffer, at);
      entry.baseOffset = offset - ofs.distance;
      at = ofs.next;
    } else if (header.kind === 7) {
      entry.baseOid = buffer.toString('hex', at, at + 20);
      at += 20;
    }
    const inflated = inflateAt(buffer.subarray(0, trailerAt), at);
    entry.data = inflated.bytes;
    at = inflated.next;
    raw.push(entry);
    byOffset.set(offset, entry);
  }
  const resolved = new Map<number, ResolvedObject>();
  const resolvedByOid = new Map<string, ResolvedObject>();
  const kinds: Record<number, GitObject['type']> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): ResolvedObject => {
    const done = resolved.get(entry.offset);
    if (done !== undefined) return done;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let value: ResolvedObject;
    if (entry.kind >= 1 && entry.kind <= 4) {
      value = { type: kinds[entry.kind], bytes: entry.data };
    } else {
      let base: ResolvedObject | undefined;
      if (entry.kind === 6) {
        const baseEntry = byOffset.get(entry.baseOffset ?? -1);
        if (baseEntry === undefined) throw new Error('missing ofs-delta base');
        base = resolve(baseEntry);
      } else {
        const oid = entry.baseOid ?? '';
        base = resolvedByOid.get(oid);
        if (base === undefined) {
          const stored = repo.objects.get(oid);
          if (stored !== undefined) base = { type: stored.type, bytes: stored.bytes };
        }
        if (base === undefined) throw new Error('missing ref-delta base');
      }
      value = { type: base.type, bytes: applyDelta(base.bytes, entry.data) };
    }
    resolving.delete(entry.offset);
    resolved.set(entry.offset, value);
    const oid = hashObject(value.type, value.bytes);
    resolvedByOid.set(oid, value);
    return value;
  };
  const incoming = new Map<string, GitObject>();
  for (const entry of raw) {
    const value = resolve(entry);
    const oid = hashObject(value.type, value.bytes);
    if (!incoming.has(oid)) incoming.set(oid, { type: value.type, bytes: value.bytes });
  }
  return incoming;
}

function indexParsedObjects(repo: Repo, incoming: Map<string, GitObject>): void {
  for (const [oid, object] of incoming) {
    repo.objects.set(oid, object);
  }
  for (const [oid, object] of incoming) {
    if (object.type === 'commit') indexCommit(repo, oid);
  }
}

function packObjectHeader(kind: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (kind << 4) | (remaining & 15);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 128);
    first = remaining & 127;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function heldTreeObjects(repo: Repo, haves: Set<string>): Set<string> {
  const held = new Set<string>();
  const queue: string[] = [];
  for (const oid of haves) {
    const commit = repo.commits.get(oid) ?? (indexCommit(repo, oid) ? repo.commits.get(oid) : undefined);
    if (commit !== undefined) queue.push(commit.tree);
  }
  for (let at = 0; at < queue.length; at += 1) {
    const oid = queue[at];
    if (oid === ZERO_OID || held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    held.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTreeEntries(object.bytes)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.sha);
      }
    }
  }
  return held;
}

function reachableFrom(repo: Repo, roots: string[], depth: number, haves: Set<string>): { ids: string[]; shallow: string[] } {
  const held = heldTreeObjects(repo, haves);
  const ids = new Set<string>();
  const shallow: string[] = [];
  const queue: { oid: string; level: number }[] = [];
  for (const root of roots) queue.push({ oid: root, level: 1 });
  for (let at = 0; at < queue.length; at += 1) {
    const { oid, level } = queue[at];
    if (oid === ZERO_OID || ids.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'commit' && haves.has(oid)) {
      if (depth !== Infinity) {
        if (level < depth) {
          const commit = repo.commits.get(oid) ?? (indexCommit(repo, oid) ? repo.commits.get(oid) : undefined);
          if (commit !== undefined) {
            for (const parent of commit.parents) queue.push({ oid: parent, level: level + 1 });
          }
        }
      }
      continue;
    }
    if (held.has(oid)) continue;
    ids.add(oid);
    if (object.type === 'commit') {
      const commit = repo.commits.get(oid) ?? (indexCommit(repo, oid) ? repo.commits.get(oid) : undefined);
      if (commit === undefined) continue;
      queue.push({ oid: commit.tree, level });
      if (level >= depth) {
        if (commit.parents.length > 0) shallow.push(oid);
      } else {
        for (const parent of commit.parents) queue.push({ oid: parent, level: level + 1 });
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTreeEntries(object.bytes)) {
        if (entry.mode === '160000') continue;
        queue.push({ oid: entry.sha, level });
      }
    } else if (object.type === 'tag') {
      const text = object.bytes.toString('utf8', 0, Math.min(64, object.bytes.length));
      const marker = 'object ';
      const start = text.indexOf(marker);
      if (start >= 0) queue.push({ oid: text.slice(start + marker.length, start + marker.length + 40), level });
    }
  }
  return { ids: [...ids], shallow };
}

function emitPack(repo: Repo, roots: string[], depth: number, haves: Set<string>): Buffer {
  const { ids, shallow } = reachableFrom(repo, roots, depth, haves);
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(ids.length, 8);
  parts.push(header);
  for (const oid of ids) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    const kind = object.type === 'commit' ? 1 : object.type === 'tree' ? 2 : object.type === 'blob' ? 3 : 4;
    parts.push(packObjectHeader(kind, object.bytes.length));
    parts.push(deflateSync(object.bytes, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  const pack = Buffer.concat([body, trailer]);
  packShallow.set(pack, shallow);
  return pack;
}

const packShallow = new WeakMap<Buffer, string[]>();
const packCache = new Map<Repo, Map<string, { pack: Buffer; shallow: string[] }>>();

export function invalidatePackCache(repo: Repo): void {
  packCache.delete(repo);
}

function getFetchPack(repo: Repo, roots: string[], depth: number, wantRefs: string[], haves: Set<string>): { pack: Buffer; shallow: string[] } {
  let bucket = packCache.get(repo);
  if (bucket === undefined) {
    bucket = new Map();
    packCache.set(repo, bucket);
  }
  const key = `${roots.join(',')}|${depth}|${wantRefs.join(',')}|${[...haves].sort().join(',')}`;
  const hit = bucket.get(key);
  if (hit !== undefined) return hit;
  const pack = emitPack(repo, roots, depth, haves);
  const shallow = packShallow.get(pack) ?? [];
  const value = { pack, shallow };
  if (bucket.size > 8) bucket.delete(bucket.keys().next().value as string);
  bucket.set(key, value);
  return value;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
    length += bytes.length;
  }
  const body = Buffer.allocUnsafe(length);
  let at = 0;
  for (const chunk of chunks) {
    chunk.copy(body, at);
    at += chunk.length;
  }
  return body;
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
  });
  res.end(body);
}

function textReply(res: ServerResponse, status: number, message: string): void {
  const body = Buffer.from(message, 'utf8');
  sendBuffer(res, status, 'text/plain; charset=utf-8', body);
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return refs;
}

function tagTarget(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return undefined;
  const text = object.bytes.toString('utf8', 0, Math.min(80, object.bytes.length));
  const start = text.indexOf('object ');
  if (start < 0) return undefined;
  const target = text.slice(start + 7, start + 47);
  return /^[0-9a-f]{40}$/.test(target) ? target : undefined;
}

function advertise(repo: Repo, service: string, protocolV2: boolean): Buffer {
  const parts: Buffer[] = [];
  if (protocolV2) {
    parts.push(pktLineEncode('version 2\n'));
    parts.push(pktLineEncode(`agent=${AGENT}\n`));
    parts.push(pktLineEncode('ls-refs=unborn\n'));
    parts.push(pktLineEncode('fetch=shallow\n'));
    parts.push(pktLineEncode('server-option\n'));
    parts.push(pktLineEncode('object-format=sha1\n'));
    parts.push(flushPkt());
    return Buffer.concat(parts);
  }
  parts.push(pktLineEncode(`# service=${service}\n`));
  parts.push(flushPkt());
  const caps = service === 'git-receive-pack'
    ? `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`
    : `side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
  const refs = sortedRefs(repo);
  const headName = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headName);
  if (headOid !== undefined) {
    parts.push(pktLineEncode(`${headOid} HEAD\0${caps}\n`));
  } else if (refs.length === 0) {
    parts.push(pktLineEncode(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  }
  for (const ref of refs) {
    parts.push(pktLineEncode(`${ref.oid} ${ref.name}\n`));
    const peeled = tagTarget(repo, ref.oid);
    if (peeled !== undefined) parts.push(pktLineEncode(`${peeled} ${ref.name}^{}\n`));
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

function lsRefsResponse(repo: Repo, lines: string[]): Buffer {
  const prefixes = lines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice(11));
  const allowed = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const wantsPeel = lines.includes('peel');
  const wantsSymref = lines.includes('symrefs');
  const wantsUnborn = lines.includes('unborn');
  const parts: Buffer[] = [];
  const headName = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headName);
  if (allowed('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLineEncode(`${headOid} HEAD${wantsSymref ? ` symref-target:${headName}` : ''}\n`));
    } else if (wantsUnborn) {
      parts.push(pktLineEncode(`unborn HEAD symref-target:${headName}\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!allowed(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantsPeel) {
      const peeled = tagTarget(repo, ref.oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    parts.push(pktLineEncode(`${line}\n`));
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const chunk = MAX_PACKET - 5;
  for (let at = 0; at < pack.length; at += chunk) {
    const slice = pack.subarray(at, Math.min(at + chunk, pack.length));
    const framed = Buffer.allocUnsafe(slice.length + 1);
    framed[0] = 1;
    slice.copy(framed, 1);
    parts.push(pktLineEncode(framed));
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

function readRequestLines(body: Buffer, stopAtFlush: boolean): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const header = body.toString('ascii', at, at + 4);
    const size = Number.parseInt(header, 16);
    if (Number.isNaN(size)) break;
    if (size === 0) {
      at += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (size === 1 || size === 2) {
      at += 4;
      continue;
    }
    if (size < 4 || at + size > body.length) break;
    lines.push(body.toString('utf8', at + 4, at + size).replace(/\n$/, ''));
    at += size;
  }
  return { lines, rest: body.subarray(at) };
}

function lineValues(lines: string[], key: string): string[] {
  const values: string[] = [];
  for (const line of lines) {
    if (!line.startsWith(`${key} `)) continue;
    const value = line.slice(key.length + 1).split(' ')[0];
    if (value !== '') values.push(value);
  }
  return values;
}

async function handleUploadPack(repo: Repo, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const protocolV2 = req.headers['git-protocol'] === 'version=2';
  const { lines } = readRequestLines(body, false);
  if (protocolV2 && lines.includes('command=ls-refs')) {
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, lines));
    return;
  }
  const wants = [...new Set(lineValues(lines, 'want'))];
  const haves = [...new Set(lineValues(lines, 'have'))];
  const shallow = [...new Set(lineValues(lines, 'shallow'))];
  const deepen = Number.parseInt(lineValues(lines, 'deepen')[0] ?? '', 10);
  const depth = Number.isFinite(deepen) && deepen > 0 ? deepen : Infinity;
  const roots = wants.filter((oid) => repo.objects.has(oid));
  const { pack, shallow: boundary } = getFetchPack(repo, roots, depth, wants, new Set(haves));
  const parts: Buffer[] = [];
  if (protocolV2) {
    const packCount = pack.readUInt32BE(8);
    if (haves.length > 0) {
      const common = haves.filter((oid) => repo.objects.has(oid));
      parts.push(pktLineEncode('acknowledgments\n'));
      if (common.length === 0) parts.push(pktLineEncode('NAK\n'));
      else for (const oid of common) parts.push(pktLineEncode(`ACK ${oid}\n`));
      if (packCount > 0) parts.push(pktLineEncode('ready\n'));
      parts.push(Buffer.from('0001', 'ascii'));
    }
    const shallowInfo: string[] = [];
    for (const oid of boundary) shallowInfo.push(`shallow ${oid}`);
    for (const oid of shallow) {
      if (!boundary.includes(oid)) shallowInfo.push(`unshallow ${oid}`);
    }
    if (shallowInfo.length > 0) {
      parts.push(pktLineEncode('shallow-info\n'));
      for (const line of shallowInfo) parts.push(pktLineEncode(`${line}\n`));
      parts.push(Buffer.from('0001', 'ascii'));
    }
    parts.push(pktLineEncode('packfile\n'));
    parts.push(sidebandPack(pack));
  } else {
    for (const oid of boundary) parts.push(pktLineEncode(`shallow ${oid}\n`));
    parts.push(pktLineEncode('NAK\n'));
    parts.push(sidebandPack(pack));
  }
  const bodyBuf = Buffer.concat(parts);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', bodyBuf);
}

function validateIncoming(repo: Repo, incoming: Map<string, GitObject>, roots: string[]): string | null {
  for (const [oid, object] of incoming) {
    if (object.type !== 'commit') continue;
    if (repo.commits.has(oid)) continue;
    const commit = parseCommitObject(object.bytes);
    repo.commits.set(oid, commit);
  }
  for (const root of roots) {
    if (!repo.objects.has(root)) return `missing object ${root}`;
    const object = repo.objects.get(root);
    if (object === undefined || object.type !== 'commit') continue;
    if (!repo.commits.has(root)) indexCommit(repo, root);
  }
  return null;
}

async function handleReceivePack(repo: Repo, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const { lines, rest } = readRequestLines(body, true);
  const commands: { old: string; next: string; ref: string }[] = [];
  let sideband = false;
  for (const line of lines) {
    const nul = line.indexOf('\0');
    const head = nul < 0 ? line : line.slice(0, nul);
    if (nul >= 0 && line.slice(nul + 1).includes('side-band-64k')) sideband = true;
    const parts = head.split(' ');
    if (parts.length < 3) continue;
    commands.push({ old: parts[0], next: parts[1], ref: parts[2] });
  }
  const incoming = rest.length >= 32 ? parsePack(rest, repo) : new Map<string, GitObject>();
  indexParsedObjects(repo, incoming);
  const status: string[] = [];
  const failure = validateIncoming(repo, incoming, commands.map((command) => command.next).filter((oid) => oid !== ZERO_OID));
  if (failure !== null) {
    status.push(`ng ${commands[0]?.ref ?? 'refs/heads/main'} ${failure}`);
  } else {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.old !== current) {
        status.push(`ng ${command.ref} fetch first`);
        continue;
      }
      if (command.next === ZERO_OID) {
        repo.refs.delete(command.ref);
        status.push(`ok ${command.ref}`);
        continue;
      }
      const target = repo.objects.get(command.next);
      if (target === undefined) {
        status.push(`ng ${command.ref} missing necessary objects`);
        continue;
      }
      if (command.old !== ZERO_OID && command.ref.startsWith('refs/heads/') && command.old !== command.next) {
        if (!isAncestor(repo, command.old, command.next)) {
          status.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
      }
      repo.refs.set(command.ref, command.next);
      status.push(`ok ${command.ref}`);
    }
  }
  if (status.some((line) => line.startsWith('ok '))) invalidatePackCache(repo);
  const report = ['unpack ok', ...status].map((line) => pktLineEncode(`${line}\n`));
  report.push(flushPkt());
  const inner = Buffer.concat(report);
  const bodyOut = sideband ? sidebandPack(inner) : inner;
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', bodyOut);
}

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repo: string,
  operation: string,
  service: string,
): Promise<void> {
  if (!authorized(req.headers.authorization)) {
    textReply(res, 401, 'Unauthorized');
    return;
  }
  const found = getRepo(owner, repo);
  if (found === undefined) {
    textReply(res, 404, 'Not Found');
    return;
  }
  try {
    if (operation === 'info/refs') {
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        textReply(res, 400, 'Bad Request');
        return;
      }
      const protocolV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
      sendBuffer(res, 200, `application/x-${service}-advertisement`, advertise(found, service, protocolV2));
      return;
    }
    if (operation === 'git-upload-pack') {
      await handleUploadPack(found, req, res);
      return;
    }
    if (operation === 'git-receive-pack') {
      await handleReceivePack(found, req, res);
      return;
    }
    textReply(res, 404, 'Not Found');
  } catch {
    if (!res.headersSent) textReply(res, 400, 'Bad Request');
    else res.destroy();
  }
}
